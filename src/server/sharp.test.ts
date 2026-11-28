import { afterEach, describe, expect, it } from "vitest";
import { imageSlots, imageWork, loadSharp } from "./sharp";

const g = globalThis as { __gluonImageGate?: unknown };

afterEach(() => {
  delete g.__gluonImageGate;
});

describe("imageSlots", () => {
  it("uses every core while leaving pool threads for file reads", () => {
    expect(imageSlots(4, 8)).toBe(4);
    expect(imageSlots(2, 8)).toBe(2);
    // Next dev keeps libuv's default pool of 4: two decodes, two threads left over.
    expect(imageSlots(16, 4)).toBe(2);
    expect(imageSlots(32, 64)).toBe(6);
    expect(imageSlots(1, 3)).toBe(1);
    expect(imageSlots(8, 1)).toBe(1);
  });
});

describe("imageWork", () => {
  it("never runs more than its limit at once, keeps order, and frees a slot when work fails", async () => {
    g.__gluonImageGate = { active: 0, waiting: [], limit: 3 };
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const jobs = Array.from({ length: 12 }, (_, i) =>
      imageWork(async () => {
        started.push(i);
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5 + ((i * 7) % 11)));
        running--;
        if (i % 4 === 1) throw new Error(`bad image ${i}`);
        return i;
      }),
    );
    const results = await Promise.allSettled(jobs);
    expect(peak).toBe(3);
    expect(started).toEqual([...Array(12).keys()]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    expect(g.__gluonImageGate).toMatchObject({ active: 0, waiting: [] });

    // The gate is whole again: a full batch still runs three wide.
    peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => imageWork(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    })));
    expect(peak).toBe(3);
  });
});

describe("loadSharp", () => {
  it("loads once with one libvips thread per image and makes a real thumbnail", async () => {
    const sharp = await loadSharp();
    expect(sharp).not.toBeNull();
    expect(await loadSharp()).toBe(sharp);
    expect(sharp!.concurrency()).toBe(1);
    const png = await sharp!({ create: { width: 900, height: 600, channels: 3, background: "#3a6" } }).png().toBuffer();
    const out = await imageWork(() => sharp!(png).resize(160, 160, { fit: "inside" }).webp().toBuffer());
    expect(await sharp!(out).metadata()).toMatchObject({ format: "webp", width: 160, height: 107 });
  });
});
