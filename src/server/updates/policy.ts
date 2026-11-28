import { baseVersion, type UpdateMethod, type UpdateSettings } from "@/lib/updates-types";

/**
 * What the background check does about an update it found, kept free of I/O so every case can be
 * tested: install it now, leave it for a later run, or leave it to a person.
 */

/** Nightly "as it lands": not within 45 minutes of the last update. */
export const ASAP_GAP_MS = 45 * 60_000;
/** Once a day: at most one automatic start per 20 hours, so a long hour can't start two. */
export const DAILY_GAP_MS = 20 * 3600_000;
/** Once a day, a version whose automatic update failed this often waits for a person. */
export const DAILY_MAX_FAILURES = 2;

export interface AutoInput {
  settings: Pick<UpdateSettings, "auto" | "channel" | "nightlyTiming" | "hour">;
  /** The option automatic updates would use; null when it isn't available. */
  option: { method: UpdateMethod; to: string | null } | null;
  runningVersion: string;
  /** False when GitHub couldn't say whether the target is really newer. */
  certain: boolean;
  now: number;
  /** Local hour now (0-23). */
  hour: number;
  /** Start of the newest update of any kind, 0 for none. */
  lastStartedAt: number;
  /** Start of the newest automatic update, 0 for none. */
  lastAutoStartedAt: number;
  /** Automatic updates to `option.to` that failed. */
  failedAutoAttempts: number;
}

export type AutoDecision =
  /** Start it now. */
  | { kind: "install" }
  /** Automatic updates will take it on a later run; nothing for a person to do. */
  | { kind: "later" }
  /** Tell a person: automatic updates are off, or won't take this one on their own. */
  | { kind: "ask"; why: "manual" | "major" | "failed" };

const majorOf = (v: string): { major: number; minor: number } | null => {
  const b = baseVersion(v);
  if (!b) return null;
  const [major, minor] = b.split(".").map(Number) as [number, number];
  return { major, minor };
};

/**
 * A new major version may change how things work, so it waits for a person. Before 1.0 a minor
 * version counts as major, the way semver reads 0.x.
 */
export function crossesMajor(from: string, to: string): boolean {
  const a = majorOf(from);
  const b = majorOf(to);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  return a.major === 0 && b.minor > a.minor;
}

export function decideAuto(i: AutoInput): AutoDecision {
  if (!i.settings.auto || !i.option) return { kind: "ask", why: "manual" };
  if (i.option.method === "github" && i.option.to && crossesMajor(i.runningVersion, i.option.to)) return { kind: "ask", why: "major" };

  if (i.settings.channel === "nightly" && i.settings.nightlyTiming === "asap") {
    if (i.failedAutoAttempts > 0) return { kind: "ask", why: "failed" };
    if (i.now - i.lastStartedAt < ASAP_GAP_MS || !i.certain) return { kind: "later" };
    return { kind: "install" };
  }

  if (i.failedAutoAttempts >= DAILY_MAX_FAILURES) return { kind: "ask", why: "failed" };
  if (!i.certain || i.hour !== i.settings.hour || i.now - i.lastAutoStartedAt <= DAILY_GAP_MS) return { kind: "later" };
  return { kind: "install" };
}

export interface ImageAutoInput {
  auto: boolean;
  /** The hour automatic updates may start in, and the local hour now. */
  windowHour: number;
  hour: number;
  now: number;
  /** What the registry check said about the running image. */
  check: { status: "same" | "newer" | "unknown" | "skipped"; remoteDigest: string | null } | null;
  /** Start of this app's newest automatic image update, 0 for none. */
  lastAttemptAt: number;
  /** Registry digests an automatic update of this app already failed on. */
  failedDigests: string[];
}

/**
 * Apps Gluon runs for itself (the Quark chat server) follow Gluon's automatic updates: in the same
 * hour, once a day, and never twice onto an image that already failed.
 */
export function decideImageAuto(i: ImageAutoInput): "install" | "later" | "failed" | "none" {
  if (i.check?.status !== "newer" || !i.check.remoteDigest) return "none";
  if (i.failedDigests.includes(i.check.remoteDigest)) return "failed";
  if (!i.auto || i.hour !== i.windowHour || i.now - i.lastAttemptAt <= DAILY_GAP_MS) return "later";
  return "install";
}
