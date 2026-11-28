import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { getSetting, setSetting } from "@/server/settings";
import { audit } from "@/server/audit";
import { hasRecentAuth } from "@/server/auth/session";
import { mfaPolicy } from "@/server/auth/policy";
import { homeRangeProblem, localIpv6Prefixes, resetZoneCache } from "@/server/net-zone";

const cidr = z
  .string()
  .max(64)
  .superRefine((v, ctx) => {
    const problem = homeRangeProblem(v);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const body = z.object({
  serverName: z.string().trim().min(1, "Give the server a name.").max(40).optional(),
  publicHost: z.string().trim().max(253).regex(/^$|^[a-z0-9.-]+$/i, "Use a plain hostname, like home.example.com").optional(),
  homeNetworks: z.array(cidr).max(32).optional(),
  mfaPolicy: z.enum(["off", "admins-away", "admins", "everyone-away", "everyone"]).optional(),
  passwordPolicy: z
    .object({
      minLength: z.number().int().min(4, "Passwords need at least 4 characters.").max(64, "64 characters is the most Gluon can require."),
      notUsername: z.boolean(),
      lettersAndNumbers: z.boolean(),
    })
    .optional(),
  sessionDays: z.number().int().min(1).max(90).optional(),
  awaySessionDays: z.number().int().min(1).max(90).optional(),
  householdCanSeeStatus: z.boolean().optional(),
  thresholds: z
    .object({
      diskAttention: z.number().min(50).max(99),
      diskFault: z.number().min(50).max(100),
      tempAttention: z.number().min(40).max(110),
      certDays: z.number().int().min(1).max(60),
      memoryAttention: z.number().min(50).max(100),
    })
    .optional(),
});

function current() {
  return {
    serverName: getSetting("serverName"),
    publicHost: getSetting("publicHost"),
    baseDomain: getSetting("baseDomain"),
    homeNetworks: getSetting("homeNetworks"),
    detectedPrefixes: localIpv6Prefixes().map((p) => `${p}/64`),
    mfaPolicy: mfaPolicy(),
    passwordPolicy: getSetting("passwordPolicy"),
    sessionDays: getSetting("sessionDays"),
    awaySessionDays: getSetting("awaySessionDays"),
    householdCanSeeStatus: getSetting("householdCanSeeStatus"),
    thresholds: getSetting("thresholds"),
  };
}

export const GET = route({ auth: "admin" }, () => current());

/** Settings that decide who counts as "home" and how sign-in works: changing them needs a fresh confirm. */
const SECURITY_KEYS = ["homeNetworks", "mfaPolicy", "passwordPolicy", "sessionDays", "awaySessionDays", "publicHost"] as const;

export const PATCH = route({ auth: "admin", body }, ({ body, user, session, ip, zone }) => {
  const now = current();
  const touchesSecurity = SECURITY_KEYS.some((k) => body[k] !== undefined && JSON.stringify(body[k]) !== JSON.stringify(now[k]));
  if (touchesSecurity && !hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
  const changed: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    setSetting(k as never, v as never);
    changed.push(k);
  }
  if (changed.includes("homeNetworks")) resetZoneCache();
  if (changed.length) audit(user, { action: "settings.server", summary: `Changed server settings (${changed.join(", ")})`, detail: body }, { ip, zone });
  return current();
});
