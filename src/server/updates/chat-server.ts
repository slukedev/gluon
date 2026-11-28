import "server-only";
import { all, now, one, run } from "../db";
import { docker } from "../docker/client";
import { invalidateApps } from "../docker/apps";
import { host } from "../host/exec";
import { lockApps } from "../apps/lock";
import { chatApps } from "../chat/backend";
import { quarkCtl } from "../chat/quark";
import { getSetting } from "../settings";
import { systemEvent } from "../audit";
import { raise, resolve } from "../findings";
import { publish } from "../events";
import { id as newId } from "../crypto";
import { QUARK_IMAGE_RE } from "@/lib/service-kind";
import { runningImages } from "./apps";
import { decideImageAuto } from "./policy";

/**
 * Quark is the chat server Gluon installs and runs, from a moving tag (ghcr.io/slukedev/quark:edge),
 * so it follows Gluon's own automatic updates: pull the newer image, recreate only Quark's service,
 * and keep it only if Quark answers on the new image. Otherwise the tag goes back to the image that
 * was running and Quark is recreated on it. Each step is recorded first, so a restart of Gluon
 * halfway through finishes the job on the next start.
 */

interface Row {
  id: string;
  app_id: string;
  container: string;
  service: string;
  ref: string;
  prev_image: string;
  new_image: string | null;
  remote_digest: string | null;
  started_at: number;
  outcome: "running" | "ok" | "failed" | "interrupted";
}

type G = typeof globalThis & { __gluonImageUpdating?: boolean };
const g = globalThis as G;

const VERIFY_MS = 120_000;

/** "ghcr.io/slukedev/quark:edge" → repo and tag; a port in the registry is not a tag. */
export function splitRef(ref: string): { repo: string; tag: string } {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { repo: ref, tag: "latest" };
}

const composeArgs = (project: string, configFile: string, ...rest: string[]) => ["compose", "-p", project, ...configFile.split(",").flatMap((f) => ["-f", f]), ...rest];

async function inspect(container: string) {
  try {
    return await docker().getContainer(container).inspect();
  } catch {
    return null;
  }
}

/** Running `image`, healthy by Docker's own check if it has one, and Quark answers its console. */
async function answers(container: string, image: string, waitMs = VERIFY_MS): Promise<boolean> {
  const end = Date.now() + waitMs;
  for (;;) {
    const info = await inspect(container);
    const health = info?.State.Health?.Status;
    if (info?.State.Running && info.Image === image && health !== "unhealthy" && health !== "starting") {
      try {
        await quarkCtl({ id: info.Id }, "status", {}, 8000);
        return true;
      } catch {
        /* still starting */
      }
    }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function retag(image: string, ref: string) {
  const { repo, tag } = splitRef(ref);
  await docker().getImage(image).tag({ repo, tag });
}

function finish(r: Pick<Row, "id">, outcome: Row["outcome"], message: string) {
  run("UPDATE image_updates SET outcome = ?, message = ?, finished_at = ? WHERE id = ?", outcome, message, now(), r.id);
}

/** Puts the image that was running back under the tag and recreates the service on it. */
async function goBack(r: Row, project: string, configFile: string): Promise<boolean> {
  await retag(r.prev_image, r.ref);
  await host("docker", composeArgs(project, configFile, "up", "-d", "--no-build", "--no-deps", "--force-recreate", r.service), { timeoutMs: 5 * 60_000 }).catch(() => undefined);
  invalidateApps();
  return answers(r.container, r.prev_image);
}

function failed(appId: string, name: string, cause: string) {
  raise({
    id: `image-update:${appId}`,
    kind: "image-update",
    severity: "attention",
    subject: appId,
    title: `${name} couldn't update on its own`,
    cause,
    remedy: { action: "", label: `Open ${name}`, href: `/apps/${encodeURIComponent(appId)}` },
  });
}

async function updateOne(app: { id: string; name: string; configFile: string }, c: { container: string; service: string; ref: string; imageId: string }, remoteDigest: string) {
  // Refused while a person moves or updates the app.
  const lock = lockApps([app.id], `${app.name} is updating`);
  const row: Row = {
    id: newId(),
    app_id: app.id,
    container: c.container,
    service: c.service,
    ref: c.ref,
    prev_image: c.imageId,
    new_image: null,
    remote_digest: remoteDigest,
    started_at: now(),
    outcome: "running",
  };
  run(
    "INSERT INTO image_updates (id, app_id, container, service, ref, prev_image, remote_digest, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')",
    row.id,
    row.app_id,
    row.container,
    row.service,
    row.ref,
    row.prev_image,
    row.remote_digest,
    row.started_at,
  );
  systemEvent({ action: "app.update", target: app.id, summary: `Started an automatic update of ${app.name}` });

  try {
    try {
      await host("docker", composeArgs(app.id, app.configFile, "pull", c.service), { timeoutMs: 15 * 60_000 });
    } catch {
      // The tag may have moved before the pull broke off.
      await retag(c.imageId, c.ref).catch(() => undefined);
      finish(row, "interrupted", "Couldn't download the new image. Nothing was changed.");
      systemEvent({ action: "app.update", target: app.id, summary: `Couldn't download a newer ${app.name}; it carries on as it was`, outcome: "failed" });
      return;
    }
    const pulled = (await docker().getImage(c.ref).inspect()).Id;
    if (pulled === c.imageId) {
      finish(row, "ok", "Already on the newest image.");
      return;
    }
    row.new_image = pulled;
    run("UPDATE image_updates SET new_image = ? WHERE id = ?", pulled, row.id);

    const up = await host("docker", composeArgs(app.id, app.configFile, "up", "-d", "--no-build", "--no-deps", c.service), { timeoutMs: 5 * 60_000 })
      .then(() => true)
      .catch(() => false);
    invalidateApps();
    if (up && (await answers(c.container, pulled))) {
      finish(row, "ok", `${app.name} is running the new image.`);
      resolve(`image-update:${app.id}`, `${app.name} updated`);
      systemEvent({ action: "app.update", target: app.id, summary: `Updated ${app.name} automatically` });
      // Nothing goes back to it now; a container still using it keeps it.
      await docker()
        .getImage(c.imageId)
        .remove()
        .catch(() => undefined);
      return;
    }
    const back = await goBack(row, app.id, app.configFile);
    finish(row, "failed", back ? "The new image didn't start, so it went back to the one it had." : "The new image didn't start, and the one it had hasn't come back yet.");
    failed(
      app.id,
      app.name,
      back
        ? `The new version didn't answer within two minutes, so ${app.name} went back to the version it had. Gluon won't install that version again on its own.`
        : `The new version didn't answer, and the version it had hasn't come back yet. Restart ${app.name} from its page.`,
    );
    systemEvent({ action: "app.update", target: app.id, summary: back ? `${app.name}'s automatic update didn't start, so it went back` : `${app.name}'s automatic update didn't start`, outcome: "failed" });
  } finally {
    lock.release();
    invalidateApps();
    publish("apps.changed", { id: app.id });
  }
}

/** An update a restart cut short: keep the new image if Quark answers on it, otherwise go back. */
async function recover() {
  for (const r of all<Row>("SELECT * FROM image_updates WHERE outcome = 'running'")) {
    const app = (await chatApps().catch(() => [])).find((x) => x.app.id === r.app_id)?.app;
    if (r.new_image && (await answers(r.container, r.new_image, 30_000))) {
      finish(r, "ok", "The new image was running after Gluon restarted.");
      continue;
    }
    if (!app?.configFile) {
      await retag(r.prev_image, r.ref).catch(() => undefined);
      finish(r, "interrupted", "Gluon restarted during the update.");
      continue;
    }
    const info = await inspect(r.container);
    if (info?.Image === r.prev_image) {
      // Stopped before the swap: the old container never went away.
      await retag(r.prev_image, r.ref).catch(() => undefined);
      finish(r, "interrupted", "Gluon restarted before the new image was used.");
      continue;
    }
    const back = await goBack(r, app.id, app.configFile).catch(() => false);
    finish(r, back ? "interrupted" : "failed", back ? "Gluon restarted during the update, so it went back to the image it had." : "Gluon restarted during the update and the image it had hasn't come back yet.");
    if (!back) failed(app.id, app.name, `Gluon restarted while it was updating ${app.name}, and ${app.name} hasn't come back. Restart it from its page.`);
  }
}

/** Called from the updates job; never while Gluon itself is updating. */
export async function updateChatServers(opts: { install?: boolean } = {}) {
  if (g.__gluonImageUpdating) return;
  if (one("SELECT id FROM self_updates WHERE outcome = 'running'") || one("SELECT id FROM image_updates WHERE outcome = 'running'")) return;
  g.__gluonImageUpdating = true;
  try {
    const settings = getSetting("updates");
    const quarks = (await chatApps({ running: true })).filter(({ app, kind }) => kind === "quark" && !!app.configFile && !app.umbrel && !app.self);
    if (!quarks.length) return;
    const images = await runningImages();
    for (const { app } of quarks) {
      const ctr = app.containers.find((x) => x.state === "running" && !!x.service && images.some((i) => i.container === x.name && QUARK_IMAGE_RE.test(i.ref)));
      const img = ctr && images.find((i) => i.container === ctr.name);
      if (!ctr?.service || !img) continue;
      const check = one<{ status: "same" | "newer" | "unknown" | "skipped"; remote_digest: string | null }>(
        "SELECT status, remote_digest FROM app_image_checks WHERE ref = ? AND image_id = ?",
        img.ref,
        img.imageId,
      );
      const decision = decideImageAuto({
        auto: settings.auto,
        windowHour: settings.hour,
        hour: new Date().getHours(),
        now: now(),
        check: check ? { status: check.status, remoteDigest: check.remote_digest } : null,
        lastAttemptAt: one<{ t: number | null }>("SELECT MAX(started_at) AS t FROM image_updates WHERE app_id = ?", app.id)?.t ?? 0,
        failedDigests: all<{ d: string }>("SELECT remote_digest AS d FROM image_updates WHERE app_id = ? AND outcome = 'failed' AND remote_digest IS NOT NULL", app.id).map((r) => r.d),
      });
      if (decision === "install" && opts.install !== false) {
        await updateOne({ id: app.id, name: app.name, configFile: app.configFile! }, { container: ctr.name, service: ctr.service, ref: img.ref, imageId: img.imageId }, check!.remote_digest!).catch((e) =>
          systemEvent({ action: "app.update", target: app.id, summary: `${app.name}'s automatic update stopped: ${(e as Error).message}`, outcome: "failed" }),
        );
      }
    }
  } finally {
    g.__gluonImageUpdating = false;
  }
}

export async function recoverChatServerUpdates() {
  if (g.__gluonImageUpdating) return;
  g.__gluonImageUpdating = true;
  try {
    await recover();
  } catch (e) {
    console.error("[gluon] finishing an interrupted chat server update failed", e);
  } finally {
    g.__gluonImageUpdating = false;
  }
}
