"use client";
import * as React from "react";
import { useFormat } from "@/components/PrefsProvider";

type Kind = "relative" | "time" | "dateTime" | "date";

const noop = () => () => {};

/** One 30-second beat for every relative time on the page, still while the tab is hidden. */
let beat = 0;
const beats = new Set<() => void>();
let beatTimer: ReturnType<typeof setInterval> | undefined;
function onBeat() {
  if (document.hidden) return;
  beat++;
  for (const l of beats) l();
}
function onVisible() {
  if (!document.hidden) onBeat();
}
function subscribeBeat(l: () => void) {
  beats.add(l);
  if (beats.size === 1) {
    beatTimer = setInterval(onBeat, 30_000);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    beats.delete(l);
    if (beats.size) return;
    clearInterval(beatTimer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
const readBeat = () => beat;
const serverBeat = () => 0;

/**
 * The server's clock, locale and zone can differ from the browser's, so the element is re-keyed once hydrated: React
 * keeps server text it was told to ignore.
 */
export function Time({ ts, kind = "relative", seconds, className }: { ts: number; kind?: Kind; seconds?: boolean; className?: string }) {
  const fmt = useFormat();
  const hydrated = React.useSyncExternalStore(noop, () => true, () => false);
  React.useSyncExternalStore(kind === "relative" ? subscribeBeat : noop, readBeat, serverBeat);
  if (!Number.isFinite(ts) || ts <= 0) {
    return <span className={className}>{kind === "relative" ? "never" : "unknown"}</span>;
  }
  const text = kind === "relative" ? fmt.relative(ts) : kind === "time" ? fmt.time(ts, seconds) : kind === "date" ? fmt.date(ts) : fmt.dateTime(ts);
  return (
    <time
      key={hydrated ? "client" : "server"}
      dateTime={new Date(ts).toISOString()}
      title={kind === "relative" ? fmt.dateTime(ts) : undefined}
      className={className}
      suppressHydrationWarning
    >
      {text}
    </time>
  );
}
