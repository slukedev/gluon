import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A real database with every migration; Docker, the host and Quark are stand-ins with state.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-chat-update-"));
process.env.GLUON_DATA = dir;

const REF = "ghcr.io/slukedev/quark:edge";
const OLD = "sha256:" + "1".repeat(64);
const NEW = "sha256:" + "2".repeat(64);
const DIGEST = "sha256:" + "d".repeat(64);
const CONTAINER = "quark-quark-1";

const world = {
  tags: new Map<string, string>(),
  running: OLD as string | null,
  removed: [] as string[],
  composeCalls: [] as string[][],
  pullFails: false,
  upFails: false,
  /** Images Quark doesn't answer on. */
  broken: new Set<string>(),
};
const idOf = (x: string) => (x.startsWith("sha256:") ? x : world.tags.get(x));

vi.mock("@/server/docker/client", () => ({
  docker: () => ({
    getContainer: (name: string) => ({
      inspect: async () => {
        if (name !== CONTAINER || !world.running) throw Object.assign(new Error("no such container"), { statusCode: 404 });
        return { Id: "c1", Image: world.running, State: { Running: true } };
      },
    }),
    getImage: (x: string) => ({
      inspect: async () => {
        const id = idOf(x);
        if (!id) throw new Error("no such image");
        return { Id: id };
      },
      tag: async ({ repo, tag }: { repo: string; tag: string }) => {
        const id = idOf(x);
        if (!id) throw new Error("no such image");
        world.tags.set(`${repo}:${tag}`, id);
      },
      remove: async () => {
        world.removed.push(x);
      },
    }),
  }),
}));
vi.mock("@/server/host/exec", () => ({
  host: async (cmd: string, args: string[]) => {
    world.composeCalls.push(args);
    if (args.includes("pull")) {
      if (world.pullFails) throw new Error("network down");
      world.tags.set(REF, NEW);
    } else if (args.includes("up")) {
      if (world.upFails && world.tags.get(REF) === NEW) throw new Error("port taken");
      world.running = world.tags.get(REF) ?? null;
    }
    return { stdout: "", stderr: "" };
  },
}));
vi.mock("@/server/docker/apps", () => ({ invalidateApps: () => undefined }));
const app = {
  id: "quark",
  name: "Quark",
  configFile: "/srv/apps/quark/docker-compose.yml",
  umbrel: null,
  self: false,
  containers: [{ name: CONTAINER, service: "quark", state: "running", image: REF }],
};
vi.mock("@/server/chat/backend", () => ({ chatApps: async () => [{ app, kind: "quark", running: true }] }));
vi.mock("@/server/chat/quark", () => ({
  quarkCtl: async () => {
    if (!world.running || world.broken.has(world.running)) throw new Error("not answering");
    return { ok: true };
  },
}));
vi.mock("./apps", () => ({
  runningImages: async () => (world.running ? [{ appId: "quark", appName: "Quark", umbrel: false, container: CONTAINER, ref: REF, imageId: world.running }] : []),
}));

type Db = typeof import("@/server/db");
type Mod = typeof import("./chat-server");
type Settings = typeof import("@/server/settings");
let db: Db;
let m: Mod;
let settings: Settings;

beforeAll(async () => {
  db = await import("@/server/db");
  m = await import("./chat-server");
  settings = await import("@/server/settings");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = new Date(2026, 10, 28, 4, 10).getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  vi.setSystemTime(T0);
  Object.assign(world, { running: OLD, removed: [], composeCalls: [], pullFails: false, upFails: false, broken: new Set() });
  world.tags = new Map([[REF, OLD]]);
  for (const t of ["image_updates", "app_image_checks", "findings", "self_updates", "audit_log"]) db.run(`DELETE FROM ${t}`);
  settings.setSetting("updates", { auto: true, channel: "stable", hour: 4, method: "github", nightlyTiming: "hour" });
  db.run("INSERT INTO app_image_checks (ref, image_id, status, remote_digest, error, checked_at) VALUES (?, ?, 'newer', ?, NULL, ?)", REF, OLD, DIGEST, T0);
});
afterEach(() => vi.useRealTimers());

async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

const rows = () => db.all<{ outcome: string; message: string; new_image: string | null }>("SELECT outcome, message, new_image FROM image_updates ORDER BY started_at");
const finding = () => db.one<{ title: string; resolved_at: number | null }>("SELECT title, resolved_at FROM findings WHERE id = 'image-update:quark'");

describe("splitRef", () => {
  it.each([
    ["ghcr.io/slukedev/quark:edge", "ghcr.io/slukedev/quark", "edge"],
    ["registry.local:5000/quark", "registry.local:5000/quark", "latest"],
    ["registry.local:5000/quark:0.2", "registry.local:5000/quark", "0.2"],
    ["quark", "quark", "latest"],
  ])("%s", (ref, repo, tag) => {
    expect(m.splitRef(ref)).toEqual({ repo, tag });
  });
});

describe("updateChatServers", () => {
  it("pulls, recreates only Quark's service, keeps it when Quark answers, and drops the old image", async () => {
    await settle(m.updateChatServers());
    expect(world.running).toBe(NEW);
    expect(rows()).toEqual([{ outcome: "ok", message: "Quark is running the new image.", new_image: NEW }]);
    expect(world.composeCalls.map((a) => a.slice(-2))).toEqual([
      ["pull", "quark"],
      ["--no-deps", "quark"],
    ]);
    expect(world.removed).toEqual([OLD]);
  });

  it("goes back to the image it had when Quark doesn't answer on the new one, and won't try that one again", async () => {
    world.broken.add(NEW);
    await settle(m.updateChatServers());
    expect(world.running).toBe(OLD);
    expect(world.tags.get(REF)).toBe(OLD);
    expect(rows()[0]).toMatchObject({ outcome: "failed", message: "The new image didn't start, so it went back to the one it had." });
    expect(finding()).toMatchObject({ title: "Quark couldn't update on its own", resolved_at: null });
    expect(world.removed).toEqual([]);

    // A day later the registry still offers the same image: left alone.
    vi.setSystemTime(T0 + 24 * 3600_000);
    db.run("INSERT INTO app_image_checks (ref, image_id, status, remote_digest, error, checked_at) VALUES (?, ?, 'newer', ?, NULL, ?) ON CONFLICT DO NOTHING", REF, OLD, DIGEST, T0);
    world.composeCalls = [];
    await settle(m.updateChatServers());
    expect(world.composeCalls).toEqual([]);
  });

  it("goes back when compose can't start the new image", async () => {
    world.upFails = true;
    await settle(m.updateChatServers());
    expect(world.running).toBe(OLD);
    expect(rows()[0]!.outcome).toBe("failed");
  });

  it("changes nothing when the download fails, and tries again another day", async () => {
    world.pullFails = true;
    await settle(m.updateChatServers());
    expect(world.running).toBe(OLD);
    expect(world.tags.get(REF)).toBe(OLD);
    expect(rows()[0]!.outcome).toBe("interrupted");

    world.pullFails = false;
    vi.setSystemTime(T0 + 24 * 3600_000);
    await settle(m.updateChatServers());
    expect(world.running).toBe(NEW);
  });

  it("waits for the automatic update hour, and does nothing with automatic updates off", async () => {
    vi.setSystemTime(new Date(2026, 10, 28, 13, 0).getTime());
    await settle(m.updateChatServers());
    settings.setSetting("updates", { auto: false, channel: "stable", hour: 13, method: "github", nightlyTiming: "hour" });
    await settle(m.updateChatServers());
    expect(world.composeCalls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("never runs while Gluon itself is updating", async () => {
    db.run("INSERT INTO self_updates (id, method, from_version, to_version, started_at, outcome, auto, log) VALUES ('u1', 'github', '1.5.1', '1.6.0', ?, 'running', 1, '/x')", T0);
    await settle(m.updateChatServers());
    expect(world.composeCalls).toEqual([]);
  });
});

describe("recoverChatServerUpdates", () => {
  const started = (newImage: string | null) =>
    db.run(
      "INSERT INTO image_updates (id, app_id, container, service, ref, prev_image, new_image, remote_digest, started_at, outcome) VALUES ('r1', 'quark', ?, 'quark', ?, ?, ?, ?, ?, 'running')",
      CONTAINER,
      REF,
      OLD,
      newImage,
      DIGEST,
      T0 - 60_000,
    );

  it("keeps the new image when Quark answers on it after the restart", async () => {
    started(NEW);
    world.tags.set(REF, NEW);
    world.running = NEW;
    await settle(m.recoverChatServerUpdates());
    expect(rows()[0]).toMatchObject({ outcome: "ok" });
    expect(world.running).toBe(NEW);
  });

  it("goes back when the restart left Quark on a new image that doesn't answer", async () => {
    started(NEW);
    world.tags.set(REF, NEW);
    world.running = NEW;
    world.broken.add(NEW);
    await settle(m.recoverChatServerUpdates());
    expect(world.running).toBe(OLD);
    expect(world.tags.get(REF)).toBe(OLD);
    expect(rows()[0]!.outcome).toBe("interrupted");
  });

  it("puts the tag back when the restart came between the download and the swap", async () => {
    started(null);
    world.tags.set(REF, NEW);
    await settle(m.recoverChatServerUpdates());
    expect(world.tags.get(REF)).toBe(OLD);
    expect(world.running).toBe(OLD);
    expect(world.composeCalls).toEqual([]);
    expect(rows()[0]!.outcome).toBe("interrupted");
  });

  it("brings Quark back when the restart left no container at all", async () => {
    started(NEW);
    world.tags.set(REF, NEW);
    world.running = null;
    await settle(m.recoverChatServerUpdates());
    expect(world.running).toBe(OLD);
    expect(rows()[0]!.outcome).toBe("interrupted");
  });
});
