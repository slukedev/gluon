"use client";
import * as React from "react";
import { SECTIONS } from "./sections";
import { SectionHeaderProvider } from "./SectionHeader";
import { SEARCH_ENGINES } from "@/lib/prefs";
import { orderedNav } from "@/lib/nav";
import { useNavAccess } from "@/components/shell/Shell";
import { usePrefs } from "@/components/PrefsProvider";
import { PageHeader } from "@/components/ui/Surface";
import { useApi } from "@/lib/client/api";
import type { UpdatesStatus } from "@/lib/updates-types";

/** Same request as the section below it, so the sentence costs nothing extra. */
function UpdatesSummary({ fallback }: { fallback: string }) {
  const { data } = useApi<UpdatesStatus>("/api/updates", { refresh: 60_000 });
  if (!data) return fallback;
  if (data.current) return `Updating to ${data.current.toVersion}.`;
  if (data.updateAvailable && data.latest) return `${data.latest.version} is out. You're on ${data.running.version}.`;
  if (data.install.kind === "development") return `Running ${data.running.version} from source.`;
  return `Running ${data.running.version}. Automatic updates are ${data.settings.auto ? "on" : "off"}.`;
}

function useSummary(id: string, fallback: string): React.ReactNode {
  const { prefs, viewer } = usePrefs();
  const access = useNavAccess();
  switch (id) {
    case "appearance": {
      const theme = prefs.theme === "system" ? "Matching your device" : prefs.theme === "dark" ? "Dark" : "Light";
      const bits = [
        `${prefs.attention === "sodium" ? "sodium" : prefs.attention} for things that need you`,
        prefs.textSize !== "default" ? `${prefs.textSize === "large" ? "larger" : "smaller"} text` : null,
        prefs.density === "compact" ? "compact rows" : null,
        prefs.contrast === "more" ? "more contrast" : null,
        prefs.motion === "reduce" ? "less motion" : null,
      ].filter(Boolean);
      return `${theme}, with ${bits.join(", ")}.`;
    }
    case "home": {
      const engine = prefs.searchEngine === "custom" ? "your own search address" : SEARCH_ENGINES[prefs.searchEngine].name;
      const start = { home: "Home", apps: "Apps", files: "Files" }[prefs.startPage];
      return `Gluon opens on ${start}. The search box uses ${engine}.`;
    }
    case "navigation": {
      const nav = orderedNav(viewer.role, prefs.sidebarOrder, prefs.sidebarHidden, access);
      return `${nav.visible.length} of ${nav.all.length} pages in the sidebar${nav.hidden.length ? `, ${nav.hidden.length} tucked away` : ""}. Single-key shortcuts are ${prefs.shortcuts ? "on" : "off"}.`;
    }
    case "updates":
      return <UpdatesSummary fallback={fallback} />;
    default:
      return fallback;
  }
}

/** The section's content comes rendered from the server, so it hydrates with the page instead of after it. */
export function SettingsView({ section, children }: { section: string | null; children: React.ReactNode }) {
  const active = section ?? "appearance";
  const current = SECTIONS.find((x) => x.id === active)!;
  const summary = useSummary(active, current.summary);
  const back = { href: "/settings", label: "Settings" };

  return current.ownHeader ? (
    <SectionHeaderProvider value={{ title: current.label, back }}>{children}</SectionHeaderProvider>
  ) : (
    <>
      <PageHeader title={current.label} summary={summary} back={back} level={section ? 1 : 2} />
      {children}
    </>
  );
}
