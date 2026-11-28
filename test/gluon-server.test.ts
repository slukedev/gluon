import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENTRY = join(import.meta.dirname, "../docker/gluon-server.cjs");

// Stands in for Next's standalone server.js: listens, reports its port, and on SIGTERM stops accepting
// and exits once every connection is gone, as Next's start-server does.
const FAKE_NEXT = `
const http = require("node:http");
const server = http.createServer((req, res) => {
  if (req.url === "/env") return res.end(JSON.stringify({ pool: process.env.UV_THREADPOOL_SIZE, peer: req.headers["x-gluon-peer"], xff: req.headers["x-forwarded-for"] ?? null }));
  if (req.url === "/stream") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": open\\n\\n"); return; }
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => process.stdout.write("PORT " + server.address().port + "\\n"));
process.on("SIGTERM", () => server.close(() => (process.env.HANG ? setInterval(() => {}, 1000) : process.exit(143))));
`;

let dir: string;
let child: ChildProcess | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gluon-entry-"));
  copyFileSync(ENTRY, join(dir, "gluon-server.cjs"));
  writeFileSync(join(dir, "server.js"), FAKE_NEXT);
});

afterEach(() => {
  child?.kill("SIGKILL");
  child = null;
  rmSync(dir, { recursive: true, force: true });
});

function start(env: Record<string, string> = {}): Promise<number> {
  const clean = { ...process.env };
  delete clean.UV_THREADPOOL_SIZE;
  child = spawn(process.execPath, ["gluon-server.cjs"], { cwd: dir, env: { ...clean, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    child!.stdout!.on("data", (b: Buffer) => {
      out += b;
      const m = out.match(/PORT (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child!.once("exit", (code) => reject(new Error(`exited early with ${code}`)));
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

function openStream(port: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/stream" }, (res) => {
      res.once("data", () => resolve(res));
      res.on("error", () => {});
    });
    req.on("error", reject);
  });
}

function exited(): Promise<{ code: number | null; ms: number }> {
  const t = performance.now();
  return new Promise((resolve) => child!.once("exit", (code) => resolve({ code, ms: performance.now() - t })));
}

describe("production entry point", () => {
  it("sizes the libuv pool to the machine unless it was set", async () => {
    const port = await start();
    const want = Math.min(64, Math.max(8, availableParallelism() * 2));
    expect(JSON.parse(await get(port, "/env")).pool).toBe(String(want));
    child!.kill("SIGKILL");

    const again = await start({ UV_THREADPOOL_SIZE: "5" });
    expect(JSON.parse(await get(again, "/env")).pool).toBe("5");
  });

  it("replaces a peer header the client sent with the socket's address", async () => {
    const port = await start();
    const seen = JSON.parse(await get(port, "/env", { "x-gluon-peer": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }));
    expect(seen.peer).toBe("127.0.0.1");
    // Loopback is a private hop, so its forwarding headers are kept for net-zone to read.
    expect(seen.xff).toBe("198.51.100.1");
  });

  it("closes connections that never finish after the drain, so SIGTERM exits promptly", async () => {
    const port = await start({ GLUON_DRAIN_MS: "300" });
    const stream = await openStream(port);
    const ended = new Promise<void>((r) => stream.once("close", () => r()));
    const done = exited();
    child!.kill("SIGTERM");
    const { code, ms } = await done;
    await ended;
    expect(code).toBe(143);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(2500);
  });

  it("exits on its own if the server never finishes closing", async () => {
    const port = await start({ GLUON_DRAIN_MS: "200", HANG: "1" });
    await openStream(port);
    const done = exited();
    child!.kill("SIGTERM");
    const { code, ms } = await done;
    expect(code).toBe(143);
    expect(ms).toBeGreaterThanOrEqual(3000);
    expect(ms).toBeLessThan(6000);
  }, 10_000);
});
