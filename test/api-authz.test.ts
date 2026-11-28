import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Who can reach which API, read from the route files themselves. A new route that household members
 * or signed-out visitors can call has to be added here on purpose; everything else is admin only.
 */

const API = path.join(process.cwd(), "src", "app", "api");

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(p);
    return e.name === "route.ts" ? [p] : [];
  });
}

const routes = routeFiles(API).map((file) => {
  const src = fs.readFileSync(file, "utf8");
  return {
    path: path.relative(API, path.dirname(file)).split(path.sep).join("/"),
    handlers: (src.match(/=\s*route\(/g) ?? []).length,
    levels: [...src.matchAll(/=\s*route\(\s*\{\s*auth:\s*"(\w+)"/g)].map((m) => m[1]!),
    src,
  };
});

/** Not behind route(), each for a reason of its own. */
const OUTSIDE_ROUTE: Record<string, RegExp> = {
  // Docker's healthcheck: says only whether the database opens.
  health: /^\s*one\("SELECT 1"\);$/m,
  // The sandboxed preview frame has no cookies; a signed, expiring token is the credential.
  "sites/preview/[token]/[[...path]]": /servePreview\(token, path/,
};

const PUBLIC = ["appstore/[...path]", "auth/enrol", "auth/invite/[token]", "auth/login", "auth/logout", "auth/mfa", "auth/setup"];

const MEMBERS = [
  "alerts/channels",
  "alerts/channels/[id]",
  "alerts/channels/test",
  "alerts/deliveries",
  "alerts/subscriptions",
  "alerts/xmpp",
  "apps",
  "auth/reauth",
  "favicon",
  "files/conflicts",
  "files/copy",
  "files/extract",
  "files/jobs",
  "files/jobs/[id]",
  "files/jobs/stream",
  "files/list",
  "files/mkdir",
  "files/move",
  "files/places",
  "files/raw",
  "files/rename",
  "files/search",
  "files/size",
  "files/stat",
  "files/text",
  "files/thumb",
  "files/trash",
  "files/trash/restore",
  "files/uploads",
  "files/uploads/[id]",
  "files/uploads/[id]/complete",
  "files/zip",
  "household/announcements",
  "household/reports",
  "household/reports/[id]",
  "icon",
  "integrations",
  "integrations/[id]/control",
  "integrations/[id]/entities",
  "integrations/[id]/image",
  "me",
  "me/home",
  "me/mfa",
  "me/password",
  "me/pins",
  "me/prefs",
  "me/sessions",
  "metrics/history",
  "metrics/live",
  "network/router/glance",
  "onboarding/summary",
  "search",
  "search/scopes",
  "shell",
  "status",
  "widgets/catalog",
  "widgets/data",
  "widgets/geocode",
  "widgets/guest-wifi",
  "widgets/internet",
];

/** Running commands, containers, disks, the network, accounts and Gluon itself: admins, always. */
const ADMIN_AREAS = ["chat", "cloudflare", "custom-apps", "diagnostics", "docker", "people", "platform", "settings", "storage", "store", "system", "terminal", "updates", "voice"];

describe("API access", () => {
  it("finds the routes", () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  it("puts every handler behind route() with an access level", () => {
    for (const r of routes) {
      const outside = OUTSIDE_ROUTE[r.path];
      if (outside) {
        expect(r.handlers, r.path).toBe(0);
        expect(r.src, r.path).toMatch(outside);
        continue;
      }
      expect(r.handlers, r.path).toBeGreaterThan(0);
      expect(r.levels.length, `${r.path}: every route() names its auth first`).toBe(r.handlers);
      for (const l of r.levels) expect(["public", "user", "admin"], r.path).toContain(l);
    }
  });

  it("lets signed-out visitors reach only sign-in, setup, invites and the app store's git", () => {
    expect(routes.filter((r) => r.levels.includes("public")).map((r) => r.path).sort()).toEqual([...PUBLIC].sort());
  });

  it("lets household members reach only what they're meant to", () => {
    expect(routes.filter((r) => r.levels.includes("user")).map((r) => r.path).sort()).toEqual([...MEMBERS].sort());
  });

  it("keeps the dangerous areas admin only", () => {
    for (const r of routes.filter((x) => ADMIN_AREAS.includes(x.path.split("/")[0]!))) {
      expect(new Set(r.levels), r.path).toEqual(new Set(["admin"]));
    }
  });

  it("asks admins to confirm it's them before anything that runs code or replaces Gluon", () => {
    for (const p of ["terminal/sessions", "updates/apply", "updates/settings", "system/updates/apply", "apps/[id]/update"]) {
      const r = routes.find((x) => x.path === p);
      expect(r, p).toBeDefined();
      expect(r!.src, p).toMatch(/recent: true|requireTerminalAuth\(session\)/);
    }
  });
});
