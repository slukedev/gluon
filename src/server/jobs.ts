import "server-only";
import { ensureSetupCode } from "./auth/setup";
import { pruneSessions } from "./auth/session";
import { pruneAttempts } from "./auth/ratelimit";
import { pruneActivity } from "./audit";
import { dockerUnreachable } from "./docker/client";

type G = typeof globalThis & { __gluonJobs?: boolean; __gluonTimers?: ReturnType<typeof setInterval>[] };
const g = globalThis as G;

/** So feature modules can add background work without touching this file. */
const starters: { name: string; start: () => void | Promise<void> }[] = [];
export function onStart(name: string, start: () => void | Promise<void>) {
  starters.push({ name, start });
}

// Docker being down fails every job that asks it, every run. Say so when it goes and when it's back, not each time.
const waitingOnDocker = new Set<() => unknown>();
export function noteDockerDown(job: () => unknown, down: boolean, log: (msg: string) => void = console.warn) {
  const before = waitingOnDocker.size;
  if (down) waitingOnDocker.add(job);
  else waitingOnDocker.delete(job);
  if (!before && waitingOnDocker.size) log("[gluon] Docker isn't answering; background work that needs it waits until it does.");
  else if (before && !waitingOnDocker.size) log("[gluon] Docker is answering again.");
}

export function every(ms: number, fn: () => unknown, opts: { immediate?: boolean } = {}) {
  // A slow run (a hung host command, a big scan) mustn't stack up behind itself: skip a tick
  // while the previous one is still going.
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
      if (waitingOnDocker.has(fn)) noteDockerDown(fn, false);
    } catch (e) {
      if (dockerUnreachable(e) || (e as { code?: string })?.code === "docker_down") noteDockerDown(fn, true);
      else console.error("[gluon] job failed", e);
    } finally {
      busy = false;
    }
  };
  if (opts.immediate) void run();
  const t = setInterval(run, ms);
  t.unref?.();
  (g.__gluonTimers ??= []).push(t);
  return t;
}

export async function startJobs() {
  if (g.__gluonJobs) return;
  g.__gluonJobs = true;
  ensureSetupCode();
  every(60 * 60_000, () => {
    pruneSessions();
    pruneAttempts();
    pruneActivity();
  }, { immediate: true });

  // Feature modules (imported for their side effects) register their own jobs.
  await import("./modules");
  for (const s of starters) {
    try {
      await s.start();
    } catch (e) {
      console.error(`[gluon] failed to start ${s.name}`, e);
    }
  }
}
