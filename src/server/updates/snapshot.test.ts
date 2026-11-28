import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-snapshot-"));
process.env.GLUON_DATA = dir;
vi.mock("@/server/docker/client", () => ({ docker: () => ({}) }));

const { snapshotDb } = await import("./index");
const { run } = await import("@/server/db");

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const snapshots = () => fs.readdirSync(path.join(dir, "backups")).filter((f) => f.endsWith(".db"));

describe("the database copy before an update", () => {
  it("holds what the running version wrote, readable only by Gluon, and keeps the last two", async () => {
    run("INSERT INTO settings (key, value) VALUES ('marker', '\"before\"')");
    await snapshotDb("1.5.1");
    const [first] = snapshots();
    expect(first).toMatch(/^gluon-before-update-1\.5\.1-\d+\.db$/);
    const file = path.join(dir, "backups", first!);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const copy = new Database(file, { readonly: true });
    expect(copy.prepare("SELECT value FROM settings WHERE key = 'marker'").get()).toEqual({ value: '"before"' });
    copy.close();

    for (const v of ["1.6.0", "1.7.0-nightly.20261128.abcdef1"]) {
      await new Promise((r) => setTimeout(r, 5));
      await snapshotDb(v);
    }
    expect(snapshots().sort()).toEqual([expect.stringContaining("1.6.0"), expect.stringContaining("1.7.0-nightly")].sort());
  });

  it("names the file safely whatever the version says", async () => {
    await snapshotDb("../../etc/x");
    expect(snapshots().some((f) => f.startsWith("gluon-before-update-.._.._etc_x-"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "etc"))).toBe(false);
  });
});
