import "server-only";
import net from "node:net";
import { all, now, one, run } from "../db";
import { AppError } from "../errors";
import { resolve } from "../findings";
import { parseAddr, type Zone } from "../net-zone";

/**
 * Stored in SQLite so it survives restarts. Failures are counted per subject and per zone, so
 * strangers hammering an account from the internet slow down the internet, never the person signing
 * in at home. Away: 5 free failures in 24 h, then 1 min doubling up to 1 h. Home: 5 in 15 min, then
 * 30 s doubling up to 15 min. Per IP: 30 in 15 min, or (away) 100 in 24 h, blocks that address for
 * the window.
 */
const HOME = { window: 15 * 60_000, free: 5, base: 30_000, max: 15 * 60_000 };
const AWAY = { window: 24 * 3600_000, free: 5, base: 60_000, max: 60 * 60_000 };
const IP_SHORT = { window: 15 * 60_000, max: 30 };
const IP_LONG = { window: 24 * 3600_000, max: 100 };

const acctKey = (subject: string, zone: Zone) => `acct:${zone}:${subject.toLowerCase()}`;
const ipKey = (ip: string) => `ip:${addressBucket(ip)}`;

function ipv6Groups(a: string): number[] | null {
  let text = a.toLowerCase();
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const o = v4[1]!.split(".").map(Number);
    text = `${text.slice(0, v4.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The unit an address is limited by. One home connection gets a whole IPv6 /64 (often a /56), so
 * counting single IPv6 addresses would let one visitor rotate through billions of them.
 */
export function addressBucket(ip: string): string {
  const a = parseAddr(ip);
  if (!a || !net.isIPv6(a)) return a ?? ip;
  const g = ipv6Groups(a);
  return g ? `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64` : a;
}

export function retryAfter(subject: string, ip: string, zone: Zone = "home"): number {
  const t = now();
  const p = zone === "away" ? AWAY : HOME;
  const acct = one<{ n: number; last: number | null }>(
    "SELECT COUNT(*) AS n, MAX(at) AS last FROM login_attempts WHERE key = ? AND at > ? AND ok = 0",
    acctKey(subject, zone),
    t - p.window,
  );
  let wait = 0;
  if (acct && acct.n >= p.free && acct.last) {
    const backoff = Math.min(p.max, p.base * 2 ** (acct.n - p.free));
    wait = Math.max(wait, acct.last + backoff - t);
  }
  const short = one<{ n: number; first: number | null }>(
    "SELECT COUNT(*) AS n, MIN(at) AS first FROM login_attempts WHERE key = ? AND at > ? AND ok = 0",
    ipKey(ip),
    t - IP_SHORT.window,
  );
  if (short && short.n >= IP_SHORT.max && short.first) wait = Math.max(wait, short.first + IP_SHORT.window - t);
  if (zone === "away") {
    const long = one<{ n: number; first: number | null }>(
      "SELECT COUNT(*) AS n, MIN(at) AS first FROM login_attempts WHERE key = ? AND at > ? AND ok = 0",
      ipKey(ip),
      t - IP_LONG.window,
    );
    if (long && long.n >= IP_LONG.max && long.first) wait = Math.max(wait, long.first + IP_LONG.window - t);
  }
  return Math.max(0, Math.ceil(wait / 1000));
}

export function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const m = Math.ceil(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/** Throws a friendly 429. */
export function guard(subject: string, ip: string, zone: Zone, what = "attempts") {
  const wait = retryAfter(subject, ip, zone);
  if (wait > 0) {
    throw new AppError("rate_limited", `Too many ${what}. Try again in ${waitText(wait)}.`, 429, { retryAfter: wait });
  }
}

type L = typeof globalThis & { __gluonAttemptLocks?: Set<string> };
const locks = () => ((globalThis as L).__gluonAttemptLocks ??= new Set<string>());

/**
 * Otherwise many requests sent at once all pass `guard()` before the first failure is recorded, and
 * the throttle allows a burst of guesses. Per zone, so tries from outside never hold up someone at
 * home.
 */
export async function oneAtATime<T>(subject: string, zone: Zone, fn: () => Promise<T>): Promise<T> {
  const key = acctKey(subject, zone);
  const held = locks();
  if (held.has(key)) {
    // Not "rate_limited": nothing is locked, so pages show this message rather than a countdown.
    throw new AppError("signin_busy", "Another sign-in to this account is being checked. Try again in a moment.", 429, { retryAfter: 1 });
  }
  held.add(key);
  try {
    return await fn();
  } finally {
    held.delete(key);
  }
}

/**
 * A success clears the subject's failures in both zones. `startedThrottle` is true for the failure
 * that started it, so the caller can tell an admin once.
 */
export function recordAttempt(subject: string, ip: string, ok: boolean, zone: Zone = "home"): { failures: number; startedThrottle: boolean } {
  const t = now();
  if (ok) {
    run("DELETE FROM login_attempts WHERE key IN (?, ?)", acctKey(subject, "home"), acctKey(subject, "away"));
    return { failures: 0, startedThrottle: false };
  }
  run("INSERT INTO login_attempts (key, at, ok) VALUES (?, ?, 0), (?, ?, 0)", acctKey(subject, zone), t, ipKey(ip), t);
  const p = zone === "away" ? AWAY : HOME;
  const n = one<{ n: number }>("SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ? AND ok = 0", acctKey(subject, zone), t - p.window)?.n ?? 0;
  return { failures: n, startedThrottle: n === p.free };
}

type G = typeof globalThis & { __gluonBursts?: Map<string, number[]> };
const g = globalThis as G;
const bursts = () => (g.__gluonBursts ??= new Map<string, number[]>());
const BURST_KEYS = 5000;

/**
 * In memory on purpose: it only has to blunt floods; the durable limits above do the real work.
 * Counts this request.
 */
export function burst(key: string, limit: number, windowMs: number): number {
  const t = Date.now();
  const m = bursts();
  const hits = (m.get(key) ?? []).filter((x: number) => x > t - windowMs);
  if (hits.length >= limit) {
    m.set(key, hits);
    return Math.max(1, Math.ceil((hits[0]! + windowMs - t) / 1000));
  }
  hits.push(t);
  // Most recently used last, so the oldest keys go first when there are too many to keep.
  m.delete(key);
  m.set(key, hits);
  while (m.size > BURST_KEYS) m.delete(m.keys().next().value!);
  return 0;
}

export function pruneAttempts() {
  run("DELETE FROM login_attempts WHERE at < ?", now() - 48 * 3600_000);
  // Throttle notices clear once their account has been quiet for a day.
  const open = all<{ id: string; last_seen: number }>("SELECT id, last_seen FROM findings WHERE kind = 'signin.throttled' AND resolved_at IS NULL");
  for (const f of open) if (now() - f.last_seen > AWAY.window) resolve(f.id, "No more failed sign-ins");
}

/** After an admin resets its password. */
export function clearThrottle(username: string) {
  const u = username.toLowerCase();
  run("DELETE FROM login_attempts WHERE key IN (?, ?, ?)", `acct:home:login:${u}`, `acct:away:login:${u}`, `user:${u}`);
}
