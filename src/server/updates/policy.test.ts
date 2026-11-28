import { describe, expect, it } from "vitest";
import { ASAP_GAP_MS, DAILY_GAP_MS, crossesMajor, decideAuto, decideImageAuto, type AutoInput } from "./policy";

const NOW = Date.UTC(2026, 10, 28, 4, 10);

type Over = Omit<Partial<AutoInput>, "settings"> & { settings?: Partial<AutoInput["settings"]> };

const input = (over: Over = {}): AutoInput => ({
  runningVersion: "1.5.1",
  option: { method: "github", to: "1.6.0" },
  certain: true,
  now: NOW,
  hour: 4,
  lastStartedAt: 0,
  lastAutoStartedAt: 0,
  failedAutoAttempts: 0,
  ...over,
  settings: { auto: true, channel: "stable", nightlyTiming: "hour", hour: 4, ...over.settings },
});

describe("crossesMajor", () => {
  it.each([
    ["1.5.1", "2.0.0", true],
    ["1.5.1", "2.0.0-nightly.20261128.abcdef1", true],
    ["1.9.9", "1.10.0", false],
    ["1.5.1", "1.5.2", false],
    ["2.0.0", "1.9.0", false],
    ["0.3.2", "0.4.0", true],
    ["0.3.2", "0.3.9", false],
    ["0.9.0", "1.0.0", true],
    ["v1.5.1", "v2.1.0", true],
    ["main-abcdef1", "2.0.0", false],
    ["1.5.1", "not-a-version", false],
  ])("%s → %s: %s", (from, to, want) => {
    expect(crossesMajor(from, to)).toBe(want);
  });
});

describe("decideAuto", () => {
  it("leaves everything to a person when automatic updates are off", () => {
    expect(decideAuto(input({ settings: { auto: false } }))).toEqual({ kind: "ask", why: "manual" });
  });

  it("leaves it to a person when the chosen method can't be used", () => {
    expect(decideAuto(input({ option: null }))).toEqual({ kind: "ask", why: "manual" });
  });

  it("installs a release in the chosen hour", () => {
    expect(decideAuto(input())).toEqual({ kind: "install" });
  });

  it("waits for the chosen hour", () => {
    expect(decideAuto(input({ hour: 3 }))).toEqual({ kind: "later" });
    expect(decideAuto(input({ hour: 5 }))).toEqual({ kind: "later" });
  });

  it("starts at most once a day, even when the hour comes round twice in a run", () => {
    expect(decideAuto(input({ lastAutoStartedAt: NOW - 30 * 60_000 }))).toEqual({ kind: "later" });
    expect(decideAuto(input({ lastAutoStartedAt: NOW - DAILY_GAP_MS }))).toEqual({ kind: "later" });
    expect(decideAuto(input({ lastAutoStartedAt: NOW - DAILY_GAP_MS - 1 }))).toEqual({ kind: "install" });
  });

  it("never acts on a guess about which build is newer", () => {
    expect(decideAuto(input({ certain: false }))).toEqual({ kind: "later" });
    expect(decideAuto(input({ certain: false, settings: { channel: "nightly", nightlyTiming: "asap" }, option: { method: "github", to: "1.6.0-nightly.20261128.abcdef1" } }))).toEqual({
      kind: "later",
    });
  });

  it("never installs a new major version on its own, on either channel", () => {
    expect(decideAuto(input({ option: { method: "github", to: "2.0.0" } }))).toEqual({ kind: "ask", why: "major" });
    expect(decideAuto(input({ settings: { channel: "nightly", nightlyTiming: "asap" }, option: { method: "github", to: "2.0.0-nightly.20261128.abcdef1" } }))).toEqual({
      kind: "ask",
      why: "major",
    });
  });

  it("leaves major versions from a store to the store, which asks for itself", () => {
    expect(decideAuto(input({ option: { method: "umbrel", to: "2.0.0" } }))).toEqual({ kind: "install" });
  });

  it("retries a failed daily update once, then waits for a person", () => {
    expect(decideAuto(input({ failedAutoAttempts: 1, lastAutoStartedAt: NOW - DAILY_GAP_MS - 1 }))).toEqual({ kind: "install" });
    expect(decideAuto(input({ failedAutoAttempts: 2, lastAutoStartedAt: NOW - DAILY_GAP_MS - 1 }))).toEqual({ kind: "ask", why: "failed" });
  });

  describe("nightly as it lands", () => {
    const asap = (over: Over = {}) =>
      input({ ...over, settings: { channel: "nightly", nightlyTiming: "asap" }, option: { method: "github", to: "1.6.0-nightly.20261128.abcdef1" } });

    it("installs at any hour", () => {
      expect(decideAuto(asap({ hour: 13 }))).toEqual({ kind: "install" });
    });

    it("keeps 45 minutes after the last update of any kind", () => {
      expect(decideAuto(asap({ lastStartedAt: NOW - ASAP_GAP_MS + 1 }))).toEqual({ kind: "later" });
      expect(decideAuto(asap({ lastStartedAt: NOW - ASAP_GAP_MS }))).toEqual({ kind: "install" });
    });

    it("doesn't rebuild a nightly that already failed", () => {
      expect(decideAuto(asap({ failedAutoAttempts: 1 }))).toEqual({ kind: "ask", why: "failed" });
    });
  });

  it("nightly once a day follows the chosen hour", () => {
    const daily = input({ settings: { channel: "nightly", nightlyTiming: "hour" }, option: { method: "github", to: "1.6.0-nightly.20261128.abcdef1" } });
    expect(decideAuto(daily)).toEqual({ kind: "install" });
    expect(decideAuto({ ...daily, hour: 9 })).toEqual({ kind: "later" });
  });
});

describe("decideImageAuto", () => {
  const DIGEST = "sha256:" + "d".repeat(64);
  const base = { auto: true, windowHour: 4, hour: 4, now: NOW, check: { status: "newer" as const, remoteDigest: DIGEST }, lastAttemptAt: 0, failedDigests: [] };

  it("installs a newer image in the automatic update hour", () => {
    expect(decideImageAuto(base)).toBe("install");
  });

  it("has nothing to do without a newer image the registry named", () => {
    expect(decideImageAuto({ ...base, check: null })).toBe("none");
    expect(decideImageAuto({ ...base, check: { status: "same", remoteDigest: DIGEST } })).toBe("none");
    expect(decideImageAuto({ ...base, check: { status: "unknown", remoteDigest: null } })).toBe("none");
    expect(decideImageAuto({ ...base, check: { status: "newer", remoteDigest: null } })).toBe("none");
  });

  it("follows Gluon's automatic updates setting and hour", () => {
    expect(decideImageAuto({ ...base, auto: false })).toBe("later");
    expect(decideImageAuto({ ...base, hour: 5 })).toBe("later");
  });

  it("tries at most once a day", () => {
    expect(decideImageAuto({ ...base, lastAttemptAt: NOW - 60_000 })).toBe("later");
    expect(decideImageAuto({ ...base, lastAttemptAt: NOW - DAILY_GAP_MS - 1 })).toBe("install");
  });

  it("never installs an image that already failed, but takes the next one", () => {
    expect(decideImageAuto({ ...base, failedDigests: [DIGEST] })).toBe("failed");
    expect(decideImageAuto({ ...base, failedDigests: ["sha256:" + "e".repeat(64)] })).toBe("install");
  });
});
