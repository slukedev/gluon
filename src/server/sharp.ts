import "server-only";
import os from "node:os";

type Sharp = typeof import("sharp").default;
type G = typeof globalThis & { __gluonSharp?: Promise<Sharp | null>; __gluonImageGate?: Gate };
const g = globalThis as G;

/**
 * sharp loaded once with one libvips thread per image: work is spread across cores by running
 * several images at once (imageWork), which keeps memory per decode small and predictable.
 * Null when sharp can't load on this machine.
 */
export function loadSharp(): Promise<Sharp | null> {
  g.__gluonSharp ??= import("sharp")
    .then((m) => {
      const s = ((m as { default?: Sharp }).default ?? m) as Sharp;
      s.cache(false);
      s.concurrency(1);
      return s;
    })
    .catch(() => null);
  return g.__gluonSharp;
}

/**
 * How many images decode at once. Each one holds a libuv pool thread for its whole decode, so a few
 * threads always stay free for file reads and DNS (pool 4, as in `next dev`, gives 2). Capped at 6
 * because one large PNG or TIFF can take a few hundred MB while it decodes.
 */
export function imageSlots(cores = os.availableParallelism(), pool = Number(process.env.UV_THREADPOOL_SIZE) || 4): number {
  return Math.max(1, Math.min(6, cores, pool - 2));
}

interface Gate {
  active: number;
  waiting: (() => void)[];
  limit: number;
}

/** Runs fn once a decode slot is free, first come first served. */
export async function imageWork<T>(fn: () => Promise<T>): Promise<T> {
  const gate = (g.__gluonImageGate ??= { active: 0, waiting: [], limit: imageSlots() });
  if (gate.active >= gate.limit) await new Promise<void>((r) => gate.waiting.push(r));
  else gate.active++;
  try {
    return await fn();
  } finally {
    const next = gate.waiting.shift();
    if (next) next();
    else gate.active--;
  }
}
