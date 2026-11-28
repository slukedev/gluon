import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db";
import { hostPath } from "../host/paths";

/**
 * Quark's own state from before an automatic update: its config folder and everything in its data
 * folder except the files people shared, taken while Quark is stopped so the database files agree
 * with each other. Going back restores exactly that set, and removes files the newer version added
 * to it (a database journal it left behind would otherwise be replayed onto the old copy).
 */

/** Where Quark keeps what it needs to start: its config and its data. */
export const QUARK_STATE_DIRS = ["/etc/quark", "/var/lib/quark"];
/** Shared files: large, and never changed by an update. */
const SKIP_DIRS = new Set(["uploads", "upload", "files", "http_upload", "media", "cache", "tmp"]);
export const SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024;
const KEEP = 2;

export interface Mount {
  /** Host path. */
  source: string;
  /** Path inside the container. */
  destination: string;
}

interface Entry {
  rel: string;
  mode: number;
  uid: number;
  gid: number;
}

interface Manifest {
  mounts: { destination: string; source: string; files: Entry[] }[];
}

export class SnapshotTooBig extends Error {}

export const snapshotsDir = (appId: string) => path.join(DATA_DIR, "backups", "chat", appId.replace(/[^A-Za-z0-9_.-]/g, "_"));

function walk(root: string, rel = ""): { rel: string; st: fs.Stats }[] {
  const out: { rel: string; st: fs.Stats }[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(path.join(root, rel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw e;
  }
  for (const name of names) {
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name.toLowerCase())) out.push(...walk(root, r));
    } else if (st.isFile()) out.push({ rel: r, st });
  }
  return out;
}

/** The mounts of Quark's state folders that live on the host (bind mounts or volumes). */
export const stateMounts = (mounts: Mount[]) => mounts.filter((m) => QUARK_STATE_DIRS.includes(m.destination) && m.source.startsWith("/"));

/** Returns the snapshot's folder. Throws SnapshotTooBig before copying anything when the set is too large. */
export function takeSnapshot(appId: string, id: string, mounts: Mount[], maxBytes = SNAPSHOT_MAX_BYTES): string {
  const plan = stateMounts(mounts).map((m) => ({ m, files: walk(hostPath(m.source)) }));
  const bytes = plan.reduce((n, p) => n + p.files.reduce((k, f) => k + f.st.size, 0), 0);
  if (bytes > maxBytes) throw new SnapshotTooBig(`${Math.round(bytes / 1024 / 1024)} MB`);
  const base = snapshotsDir(appId);
  const dir = path.join(base, id);
  const tmp = `${dir}.partial`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const manifest: Manifest = { mounts: [] };
  plan.forEach(({ m, files }, i) => {
    const into = path.join(tmp, String(i));
    for (const f of files) {
      const to = path.join(into, f.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(hostPath(m.source), f.rel), to);
    }
    manifest.mounts.push({ destination: m.destination, source: m.source, files: files.map((f) => ({ rel: f.rel, mode: f.st.mode & 0o7777, uid: f.st.uid, gid: f.st.gid })) });
  });
  fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest));
  fs.renameSync(tmp, dir);
  prune(base);
  return dir;
}

function prune(base: string) {
  // Left by a copy a crash cut short; never restored from.
  for (const n of fs.readdirSync(base)) if (n.endsWith(".partial")) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  const all = fs
    .readdirSync(base)
    .filter((n) => !n.endsWith(".partial") && fs.existsSync(path.join(base, n, "manifest.json")))
    .map((n) => ({ n, t: fs.statSync(path.join(base, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { n } of all.slice(KEEP)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
}

/** Puts the snapshot's files back where they came from. Quark must be stopped. */
export function restoreSnapshot(dir: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  manifest.mounts.forEach((m, i) => {
    const root = hostPath(m.source);
    const keep = new Set(m.files.map((f) => f.rel));
    for (const f of walk(root)) if (!keep.has(f.rel)) fs.rmSync(path.join(root, f.rel), { force: true });
    for (const f of m.files) {
      const to = path.join(root, f.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // Through a temporary name, so a crash mid-copy never leaves half a database in place.
      const part = `${to}.gluon-restore`;
      fs.copyFileSync(path.join(dir, String(i), f.rel), part);
      fs.chmodSync(part, f.mode);
      try {
        fs.chownSync(part, f.uid, f.gid);
      } catch {
        /* not root (development) */
      }
      fs.renameSync(part, to);
    }
  });
}
