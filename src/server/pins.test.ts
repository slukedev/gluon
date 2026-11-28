import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-pins-"));
process.env.GLUON_DATA = dir;

let db: typeof import("./db");
let pins: typeof import("./pins");

beforeAll(async () => {
  db = await import("./db");
  pins = await import("./pins");
  db.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES ('u1', 'ana', 'Ana', 'member', 'x', 1, 1)");
});
beforeEach(() => db.run("DELETE FROM pins"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("pins become safe sidebar links", () => {
  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "//evil.example/x", "/\\evil.example", "https://evil.example/", "/login?next=/x", "/api/files/raw?path=/"])(
    "refuses %j as a page",
    (target) => {
      expect(() => pins.addPin("u1", "page", target, "Page")).toThrow(/page on this server/);
    },
  );

  it.each(["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,hi", "file:///etc/passwd", "not a url"])("refuses %j as a link", (target) => {
    expect(() => pins.addPin("u1", "link", target, "Link")).toThrow(/http:\/\/ or https:\/\//);
  });

  it("keeps pages and web links, normalised, and never stores a refused one", () => {
    expect(pins.addPin("u1", "page", "/files?path=%2Fmnt#top", "Media").target).toBe("/files?path=%2Fmnt#top");
    expect(pins.addPin("u1", "link", "HTTPS://Example.com", "Example").target).toBe("https://example.com/");
    expect(() => pins.addPin("u1", "link", "javascript:void 0", "Bad")).toThrow();
    expect(pins.listPins("u1").map((p) => p.target)).toEqual(["https://example.com/", "/files?path=%2Fmnt#top"]);
  });
});
