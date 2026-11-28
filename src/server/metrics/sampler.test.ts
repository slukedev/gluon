import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = vi.hoisted(() => {
  const d = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "gluon-metrics-"));
  process.env.GLUON_DATA = d;
  return d as string;
});

import { all, run } from "../db";
import { rollup, unescapeMount } from "./sampler";

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("unescapeMount", () => {
  it("decodes the octal escapes /proc/mounts uses", () => {
    expect(unescapeMount("/srv/My\\040Films")).toBe("/srv/My Films");
    expect(unescapeMount("/mnt/tab\\011and\\134slash")).toBe("/mnt/tab\tand\\slash");
    expect(unescapeMount("/plain")).toBe("/plain");
  });
});

describe("rollup", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const T0 = Date.UTC(2031, 0, 20, 12, 30);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    run("DELETE FROM metrics");
    run("DELETE FROM metrics_hour");
  });

  const minutes = (key: string, from: number, to: number, value: (ts: number) => number) => {
    for (let ts = from; ts < to; ts += 60_000) run("INSERT INTO metrics (key, ts, value) VALUES (?, ?, ?)", key, ts, value(ts));
  };
  const hours = (key: string) => all<{ ts: number; avg: number; max: number }>("SELECT ts, avg, max FROM metrics_hour WHERE key = ? ORDER BY ts", key);

  it("folds each finished hour older than two days, per key, and leaves recent minutes alone", () => {
    const h = Math.floor((T0 - 3 * DAY) / HOUR) * HOUR;
    minutes("cpu", h, h + 2 * HOUR, (ts) => (ts < h + HOUR ? 10 : 30));
    minutes("ctr.web.cpu", h, h + HOUR, (ts) => (ts - h) / 60_000);
    minutes("cpu", T0 - HOUR, T0, () => 99);
    rollup();
    expect(hours("cpu")).toEqual([
      { ts: h, avg: 10, max: 10 },
      { ts: h + HOUR, avg: 30, max: 30 },
    ]);
    expect(hours("ctr.web.cpu")).toEqual([{ ts: h, avg: 29.5, max: 59 }]);
    expect(all("SELECT ts FROM metrics_hour WHERE ts >= ?", T0 - 2 * DAY)).toEqual([]);
  });

  it("only adds hours after the last one it folded, so a later run doesn't redo old ones", () => {
    const h = Math.floor((T0 - 3 * DAY) / HOUR) * HOUR;
    minutes("cpu", h, h + HOUR, () => 10);
    rollup();
    // A minute row that sneaks into an already folded hour isn't counted again.
    run("INSERT OR REPLACE INTO metrics (key, ts, value) VALUES ('cpu', ?, 1000)", h);
    minutes("cpu", h + HOUR, h + 2 * HOUR, () => 20);
    vi.setSystemTime(T0 + HOUR);
    rollup();
    expect(hours("cpu").map((r) => r.avg)).toEqual([10, 20]);
  });

  it("drops minute data past a week and hourly data past 400 days, for every key", () => {
    minutes("cpu", T0 - 8 * DAY, T0 - 8 * DAY + 5 * 60_000, () => 1);
    minutes("gone.container", T0 - 8 * DAY, T0 - 8 * DAY + 5 * 60_000, () => 1);
    run("INSERT INTO metrics_hour (key, ts, avg, max) VALUES ('ctr.removed.cpu', ?, 1, 1)", T0 - 401 * DAY);
    run("INSERT INTO metrics_hour (key, ts, avg, max) VALUES ('ctr.removed.cpu', ?, 2, 2)", T0 - 300 * DAY);
    rollup();
    expect(all("SELECT key FROM metrics WHERE ts < ?", T0 - 7 * DAY)).toEqual([]);
    expect(hours("ctr.removed.cpu").map((r) => r.avg)).toEqual([2]);
  });
});
