import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-chat-data-"));
process.env.GLUON_DATA = path.join(dir, "gluon");
process.env.GLUON_HOST_ROOT = "/";
const LIB = path.join(dir, "lib");
const mounts = [
  { source: LIB, destination: "/var/lib/quark" },
  { source: path.join(dir, "elsewhere"), destination: "/srv/media" },
  { source: "named-volume", destination: "/etc/quark" },
];

const { restoreSnapshot, snapshotsDir, takeSnapshot, SnapshotTooBig } = await import("./chat-data");

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(LIB, { recursive: true, force: true });
  fs.rmSync(snapshotsDir("quark"), { recursive: true, force: true });
  fs.mkdirSync(path.join(LIB, "rooms"), { recursive: true });
  fs.mkdirSync(path.join(LIB, "Uploads"), { recursive: true });
  fs.writeFileSync(path.join(LIB, "quark.db"), "one");
  fs.writeFileSync(path.join(LIB, "rooms", "lobby.json"), "{}");
  fs.chmodSync(path.join(LIB, "quark.db"), 0o640);
  fs.writeFileSync(path.join(LIB, "Uploads", "big.bin"), "shared");
});

describe("Quark's state before an update", () => {
  it("copies only Quark's own folders from the host, without shared files", () => {
    const snap = takeSnapshot("quark", "a", mounts);
    const manifest = JSON.parse(fs.readFileSync(path.join(snap, "manifest.json"), "utf8"));
    expect(manifest.mounts.map((m: { destination: string }) => m.destination)).toEqual(["/var/lib/quark"]);
    expect(manifest.mounts[0].files.map((f: { rel: string }) => f.rel).sort()).toEqual(["quark.db", "rooms/lobby.json"]);
  });

  it("puts back exactly what it copied: changed files, removed files, new files, and modes", () => {
    const snap = takeSnapshot("quark", "a", mounts);
    fs.writeFileSync(path.join(LIB, "quark.db"), "two");
    fs.chmodSync(path.join(LIB, "quark.db"), 0o600);
    fs.rmSync(path.join(LIB, "rooms", "lobby.json"));
    fs.writeFileSync(path.join(LIB, "quark.db-shm"), "x");
    fs.writeFileSync(path.join(LIB, "Uploads", "new.bin"), "kept");
    restoreSnapshot(snap);
    expect(fs.readFileSync(path.join(LIB, "quark.db"), "utf8")).toBe("one");
    expect(fs.statSync(path.join(LIB, "quark.db")).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(path.join(LIB, "rooms", "lobby.json"), "utf8")).toBe("{}");
    expect(fs.existsSync(path.join(LIB, "quark.db-shm"))).toBe(false);
    expect(fs.readdirSync(path.join(LIB, "Uploads")).sort()).toEqual(["big.bin", "new.bin"]);
  });

  it("refuses before copying anything when the state is too large", () => {
    expect(() => takeSnapshot("quark", "a", mounts, 3)).toThrow(SnapshotTooBig);
    expect(fs.existsSync(snapshotsDir("quark"))).toBe(false);
  });

  it("keeps the newest two copies and clears one a crash left half written", async () => {
    for (const id of ["a", "b", "c"]) {
      takeSnapshot("quark", id, mounts);
      await new Promise((r) => setTimeout(r, 10));
    }
    fs.mkdirSync(path.join(snapshotsDir("quark"), "d.partial"));
    takeSnapshot("quark", "e", mounts);
    expect(fs.readdirSync(snapshotsDir("quark")).sort()).toEqual(["c", "e"]);
  });
});
