import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-crypto-"));
const data = path.join(dir, "data");
const elsewhere = path.join(dir, "keys", "secret.key");
vi.stubEnv("GLUON_DATA", data);
const C = await import("./crypto");
const reset = () => delete (globalThis as { __gluonKey?: Buffer }).__gluonKey;

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  reset();
  vi.unstubAllEnvs();
  vi.stubEnv("GLUON_DATA", data);
});

describe("the secret key's home", () => {
  it("moves an existing key out of the data folder, and what it sealed still opens", () => {
    const sealed = C.encrypt("router password");
    expect(fs.existsSync(path.join(data, "secret.key"))).toBe(true);
    reset();
    vi.stubEnv("GLUON_SECRET_KEY_FILE", elsewhere);
    expect(C.decrypt(sealed)).toBe("router password");
    expect(fs.existsSync(path.join(data, "secret.key"))).toBe(false);
    expect(fs.statSync(elsewhere).mode & 0o777).toBe(0o600);
  });

  it("drops the same key when an old backup of the data folder brings it back", () => {
    vi.stubEnv("GLUON_SECRET_KEY_FILE", elsewhere);
    fs.copyFileSync(elsewhere, path.join(data, "secret.key"));
    C.encrypt("x");
    expect(fs.existsSync(path.join(data, "secret.key"))).toBe(false);
  });

  it("refuses a file that isn't a key rather than making a new one over it", () => {
    vi.stubEnv("GLUON_SECRET_KEY_FILE", path.join(dir, "not-a-key"));
    fs.writeFileSync(path.join(dir, "not-a-key"), "hello");
    expect(() => C.encrypt("x")).toThrow(/wrong length/);
  });
});

describe("sealed secrets", () => {
  it("opens what it sealed and nothing that was changed", () => {
    const sealed = C.encrypt("cloudflare token");
    expect(C.decrypt(sealed)).toBe("cloudflare token");
    const [v, iv, tag, body] = sealed.split(".") as [string, string, string, string];
    const flipped = Buffer.from(body, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => C.decrypt([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
  });

  it("refuses a shortened tag, which would be far easier to forge", () => {
    const [v, iv, tag, body] = C.encrypt("x").split(".") as [string, string, string, string];
    const short = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");
    expect(() => C.decrypt([v, iv, short, body].join("."))).toThrow();
  });
});
