import type { ApiError } from "@/lib/client/api";

type Kind = "missing" | "timeout" | "other";

export function hostFailure(error: Pick<ApiError, "message" | "details">): { kind: Kind; program: string | null; command: string | null } {
  const command = typeof error.details?.command === "string" ? error.details.command : null;
  const first = command?.split(" ")[0] ?? null;
  // Locally the spawn fails; on the server commands run through nsenter, which says it in its own words.
  const gone =
    /spawn (\S+) ENOENT/.exec(error.message) ??
    /nsenter: failed to execute (\S+): No such file/.exec(error.message) ??
    (first ? new RegExp(`(?:^|\\s)(${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}): (?:command )?not found`).exec(error.message) : null);
  const program = gone?.[1] ?? first;
  if (gone) return { kind: "missing", program, command };
  if (/^Timed out/i.test(error.message)) return { kind: "timeout", program, command };
  return { kind: "other", program, command };
}

export type CheckState = "ok" | "loading" | "failed" | "missing";

export function checkState(data: unknown, error: Pick<ApiError, "message" | "details"> | null | undefined): CheckState {
  if (data) return "ok";
  if (!error) return "loading";
  return hostFailure(error).kind === "missing" ? "missing" : "failed";
}

export interface CheckFacts {
  updates: CheckState;
  services: CheckState;
  /** No service has failed. */
  servicesQuiet: boolean;
  /** Nothing waiting or installing: what the last apt refresh says. `null` when there is news to tell instead. */
  updatesQuiet: "current" | "unchecked" | "refresh-failed" | null;
  /** The header already leads with news; then only the checks that didn't answer are added. */
  hasNews: boolean;
}

/** The System header's account of its checks: the all-clear only from checks that answered, and every check that didn't. */
export function checksSummary(f: CheckFacts): string {
  const out: string[] = [];
  if (!f.hasNews) {
    const running = f.services === "ok" && f.servicesQuiet;
    const quiet = f.updates === "ok" ? f.updatesQuiet : null;
    if (running && quiet === "current") out.push("Everything is running and up to date.");
    else {
      if (running) out.push("Everything is running.");
      if (quiet) out.push({ current: "Up to date.", unchecked: "Updates haven't been checked yet.", "refresh-failed": "Couldn't check for updates." }[quiet]);
    }
  }
  const named = (state: CheckState) => (["updates", "services"] as const).filter((k) => f[k] === state);
  const failed = named("failed");
  const missing = named("missing");
  const loading = named("loading");
  if (failed.length) out.push(`Couldn't check ${failed.join(" or ")}.`);
  if (missing.length) out.push(`${missing.length > 1 ? "Updates and services" : missing[0] === "updates" ? "Updates" : "Services"} can't be checked on this server.`);
  if (loading.length) out.push(`${out.length || f.hasNews ? "Still checking" : "Checking"} ${loading.join(" and ")}.`);
  return out.join(" ");
}
