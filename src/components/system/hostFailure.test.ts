import { describe, expect, it } from "vitest";
import { checkState, checksSummary, hostFailure } from "./hostFailure";

describe("hostFailure", () => {
  it("reads a program the host doesn't have as missing, not broken", () => {
    expect(hostFailure({ message: "spawn apt ENOENT", details: { command: "apt list --upgradable" } })).toEqual({ kind: "missing", program: "apt", command: "apt list --upgradable" });
  });

  it("reads nsenter's own wording on the server the same way", () => {
    expect(hostFailure({ message: "nsenter: failed to execute apt: No such file or directory", details: { command: "apt list --upgradable" } })).toMatchObject({ kind: "missing", program: "apt" });
  });

  it("only calls it missing when the missing program is the one that was run", () => {
    expect(hostFailure({ message: "sh: 1: foo: not found", details: { command: "apt list --upgradable" } }).kind).toBe("other");
    expect(hostFailure({ message: "sh: 1: apt: not found", details: { command: "apt list --upgradable" } }).kind).toBe("missing");
  });

  it("treats a timeout as a fault worth retrying", () => {
    expect(hostFailure({ message: "Timed out: systemctl list-units" }).kind).toBe("timeout");
  });

  it("keeps a missing file inside a working program a real failure", () => {
    expect(hostFailure({ message: "E: Could not open lock file /var/lib/dpkg/lock - open (2: No such file or directory)" }).kind).toBe("other");
  });
});

describe("checksSummary", () => {
  const base = { servicesQuiet: true, updatesQuiet: "current" as const, hasNews: false };
  const aptGone = { message: "spawn apt ENOENT", details: { command: "apt list --upgradable" } };

  it("reads stale data as answered, no data and no error as still loading", () => {
    expect(checkState({ list: [] }, { message: "Timed out" })).toBe("ok");
    expect(checkState(undefined, null)).toBe("loading");
    expect(checkState(undefined, aptGone)).toBe("missing");
    expect(checkState(undefined, { message: "Timed out: apt" })).toBe("failed");
  });

  it("names the check that's still loading when the other one failed", () => {
    expect(checksSummary({ ...base, updates: "loading", services: "failed" })).toBe("Couldn't check services. Still checking updates.");
  });

  it("gives the all-clear only for the check that answered", () => {
    expect(checksSummary({ ...base, updates: "loading", services: "ok" })).toBe("Everything is running. Still checking updates.");
    expect(checksSummary({ ...base, updates: "ok", services: "failed" })).toBe("Up to date. Couldn't check services.");
    expect(checksSummary({ ...base, updates: "ok", services: "ok" })).toBe("Everything is running and up to date.");
    expect(checksSummary({ ...base, updates: "ok", services: "ok", updatesQuiet: "refresh-failed" })).toBe("Everything is running. Couldn't check for updates.");
  });

  it("says each kind of gap once, joined", () => {
    expect(checksSummary({ ...base, updates: "loading", services: "loading" })).toBe("Checking updates and services.");
    expect(checksSummary({ ...base, updates: "failed", services: "failed" })).toBe("Couldn't check updates or services.");
    expect(checksSummary({ ...base, updates: "missing", services: "failed" })).toBe("Couldn't check services. Updates can't be checked on this server.");
    expect(checksSummary({ ...base, updates: "missing", services: "missing" })).toBe("Updates and services can't be checked on this server.");
  });

  it("adds only the gaps after news, never a contradicting all-clear", () => {
    expect(checksSummary({ ...base, hasNews: true, updates: "ok", services: "ok" })).toBe("");
    expect(checksSummary({ ...base, hasNews: true, servicesQuiet: false, updates: "loading", services: "ok" })).toBe("Still checking updates.");
    expect(checksSummary({ ...base, servicesQuiet: false, updates: "ok", services: "ok", updatesQuiet: null })).toBe("");
  });
});
