import type { LineState } from "@/lib/types";
import { findingWord } from "@/lib/finding-words";

/**
 * What counts as an app needing a hand, and how that reads, in one place: Apps, an app's page, Home
 * and the status sentence all ask here, so they never disagree on the count, the mark or the words.
 */

/**
 * A container that ran to the end and was never meant to stay up: a setup or migration job. It
 * exited cleanly and either its restart policy doesn't bring it back after a clean exit, or the
 * compose file marks it a one-off (another service waits for it to complete, or `gluon.one-shot`).
 */
export function finishedJob(c: { state: string; exitCode: number | null; restartPolicy: string | null; oneShot: boolean }): boolean {
  if (c.state !== "exited" || c.exitCode !== 0) return false;
  if (c.oneShot) return true;
  return c.restartPolicy === "no" || c.restartPolicy === "" || c.restartPolicy === "on-failure";
}

export interface HealthContainer {
  state?: string;
  line: LineState;
  /** A finished one-off job (finishedJob). */
  done?: boolean;
}

export interface HealthApp {
  line: LineState;
  summary: string;
  containers: HealthContainer[];
  copyOf?: unknown;
  umbrel?: { state: string } | null;
}

interface FindingLike {
  kind: string;
  severity: string;
}

const parts = (n: number) => (n === 1 ? "1 part" : `${n} parts`);
const UMBREL_BUSY = new Set(["installing", "updating", "uninstalling"]);

/** Docker's words (unhealthy, restarting, containers) stay on the detail page and in tooltips. */
export function trouble(a: HealthApp): string | null {
  if (a.line !== "unhealthy" || a.copyOf) return null;
  const live = a.containers.filter((c) => !c.done);
  const n = live.length;
  const bad = live.filter((c) => c.line === "unhealthy" || c.line === "stopped");
  if (!n || !bad.length) return a.summary;
  const restarting = bad.filter((c) => c.state === "restarting").length;
  const stopped = bad.filter((c) => c.line === "stopped").length;
  if (n === 1) return restarting ? "Keeps restarting" : stopped ? "Stopped by itself" : "Not responding";
  if (restarting === n) return "Keeps restarting";
  if (bad.length === n) return "Not responding";
  const what = restarting ? "keeps restarting" : stopped === bad.length ? "stopped" : "isn't responding";
  return bad.length === 1 ? `1 of ${parts(n)} ${what}` : `${bad.length} of ${n} parts ${restarting ? "keep restarting" : stopped === bad.length ? "stopped" : "aren't responding"}`;
}

/** Broken by its own containers' state. Starting, stopped on purpose and old copies aren't. */
export function isProblem(a: HealthApp): boolean {
  return !a.copyOf && a.line === "unhealthy" && !UMBREL_BUSY.has(a.umbrel?.state ?? "");
}

/**
 * The mark and words for an app that needs a hand, or null when it doesn't. Its own containers come
 * first (they say what's wrong most exactly), then an open finding about it.
 */
export function appMark(a: HealthApp, finding?: FindingLike | null): { state: LineState; word: string } | null {
  if (isProblem(a)) return { state: "unhealthy", word: trouble(a) ?? "Not working" };
  if (finding && !a.copyOf) return { state: finding.severity === "fault" ? "unhealthy" : "attention", word: findingWord(finding) };
  return null;
}

/** Every app that needs a hand: the count on Apps and the apps the status sentence adds to findings. */
export function needingHand<A extends HealthApp & { id: string }>(apps: readonly A[], findingOf: ReadonlyMap<string, FindingLike>): A[] {
  return apps.filter((a) => !!appMark(a, findingOf.get(a.id)));
}
