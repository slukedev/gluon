import { describe, expect, it, vi } from "vitest";
import type { Finding } from "./findings";
import type { StatusApp } from "./status";
import { findingsByApp } from "@/lib/finding-words";
import { needingHand } from "@/lib/app-health";

vi.mock("./people/household", () => ({ currentAnnouncements: async () => [] }));
vi.mock("./docker/apps", () => ({ listApps: async () => [], appsForMember: async () => [] }));
vi.mock("./findings", () => ({ listOpen: () => [] }));
vi.mock("./metrics/sampler", () => ({ filesystems: () => [], latestHost: () => null }));
vi.mock("./audit", () => ({ listActivity: () => [] }));

const { verdictFor } = await import("./status");

const ctr = (state: string, line: StatusApp["line"], done = false) => ({ name: "c", service: "s", state, line, done });
const app = (id: string, line: StatusApp["line"], containers: StatusApp["containers"]): StatusApp => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  icon: null,
  line,
  summary: "",
  containers,
  urls: { home: null, away: null },
  household: true,
  source: "compose",
  copyOf: null,
  umbrel: null,
});
const finding = (subject: string, severity: "fault" | "attention", title: string) => ({ id: `${subject}:${title}`, kind: "app.broken", severity, subject, title }) as unknown as Finding;

describe("the status sentence counts what Apps counts", () => {
  // Immich's setup job finished cleanly; Jellyfin keeps restarting with an open finding.
  const immich = app("immich", "running", [ctr("running", "running"), ctr("exited", "stopped", true)]);
  const jellyfin = app("jellyfin", "unhealthy", [ctr("restarting", "unhealthy")]);
  const findings = [finding("jellyfin", "fault", "Jellyfin keeps crashing")];

  it("leaves an app whose one-off job finished out of it", () => {
    expect(verdictFor(findings, [immich, jellyfin], false)).toMatchObject({ tone: "fault", headline: "Jellyfin keeps crashing." });
    expect(needingHand([immich, jellyfin], findingsByApp(findings)).map((a) => a.id)).toEqual(["jellyfin"]);
  });

  it("counts an app broken by its own containers before any finding is raised", () => {
    const paperless = app("paperless", "unhealthy", [ctr("running", "running"), ctr("exited", "stopped")]);
    expect(verdictFor([], [immich, paperless], false)).toMatchObject({ tone: "fault", headline: "Paperless needs a hand." });
    expect(verdictFor(findings, [immich, jellyfin, paperless], false).headline).toBe("2 things are broken.");
  });

  it("is calm when the only thing that stopped was a finished job", () => {
    expect(verdictFor([], [immich], false)).toMatchObject({ tone: "ok", headline: "Everything is running." });
    expect(verdictFor([], [immich], true)).toMatchObject({ tone: "ok", headline: "Everything's working." });
  });
});
