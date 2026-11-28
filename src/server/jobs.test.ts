import fs from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = vi.hoisted(() => {
  const d = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "gluon-jobs-"));
  process.env.GLUON_DATA = d;
  return d as string;
});

import { noteDockerDown } from "./jobs";
import { dockerUnreachable } from "./docker/client";

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Docker down in background jobs", () => {
  it("says it once when the first job finds Docker gone, and once when the last one gets through", () => {
    const said: string[] = [];
    const log = (m: string) => said.push(m);
    const sampler = () => 0;
    const updates = () => 0;
    for (let i = 0; i < 15; i++) {
      noteDockerDown(sampler, true, log);
      noteDockerDown(updates, true, log);
    }
    expect(said).toHaveLength(1);
    noteDockerDown(sampler, false, log);
    expect(said).toHaveLength(1);
    noteDockerDown(updates, false, log);
    expect(said).toEqual([expect.stringMatching(/isn't answering/), expect.stringMatching(/answering again/)]);
  });

  it("tells Docker's socket apart from any other missing file or refused connection", () => {
    expect(dockerUnreachable(Object.assign(new Error("connect ENOENT /var/run/docker.sock"), { code: "ENOENT", syscall: "connect", address: "/var/run/docker.sock" }))).toBe(true);
    expect(dockerUnreachable(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", syscall: "connect", address: "/var/run/docker.sock" }))).toBe(true);
    expect(dockerUnreachable(Object.assign(new Error("ENOENT: no such file, open '/data/x'"), { code: "ENOENT", syscall: "open", path: "/data/x" }))).toBe(false);
    expect(dockerUnreachable(Object.assign(new Error("connect ECONNREFUSED 10.0.0.2:443"), { code: "ECONNREFUSED", syscall: "connect", address: "10.0.0.2" }))).toBe(false);
    expect(dockerUnreachable(null)).toBe(false);
  });
});
