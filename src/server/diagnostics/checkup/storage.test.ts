import fs from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = vi.hoisted(() => {
  const d = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "gluon-inodes-"));
  process.env.GLUON_DATA = d;
  return d as string;
});

import type { FsUsage } from "../../metrics/sampler";
import { inodeOutcome } from "./storage";

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const mount = (m: string, fstype = "ext4"): FsUsage => ({ mount: m, device: `/dev/${m.slice(1) || "root"}`, fstype, size: 1e12, used: 1e11, avail: 9e11, pct: 10 });
const slots = (files: number, ffree: number) => ({ files, ffree }) as fs.StatsFs;

describe("inodeOutcome", () => {
  it("names a mount that didn't answer and still judges the ones that did", async () => {
    const out = await inodeOutcome([mount("/"), mount("/media/usb", "fuseblk")], async (p) => (p.includes("usb") ? null : slots(1000, 20)));
    expect(out.state).toBe("fail");
    expect(out.evidence).toContain("didn't answer");
  });

  it("calls it unreadable, not fine, when every read failed or hung", async () => {
    const out = await inodeOutcome([mount("/srv"), mount("/media/usb", "fuseblk")], async (p) => (p.includes("usb") ? null : Promise.reject(new Error("EIO"))));
    expect(out.state).toBe("skip");
    expect(out.title).toBe("Couldn't read how many file slots are used");
  });

  it("never asks a network share", async () => {
    const asked: string[] = [];
    const out = await inodeOutcome([mount("/mnt/nas", "nfs4"), mount("/srv")], async (p) => (asked.push(p), slots(1000, 900)));
    expect(asked).toHaveLength(1);
    expect(out.state).toBe("ok");
  });
});
