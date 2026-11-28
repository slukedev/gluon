import type { Prefs } from "./prefs-schema";

export type { Prefs };

/** The subset mirrored into a cookie so the server can render the right theme without a flash. */
export const UI_COOKIE = "gluon_ui";
export type UiBits = Pick<Prefs, "theme" | "attention" | "contrast" | "density" | "textSize" | "motion">;
export function uiBits(p: Prefs): UiBits {
  return { theme: p.theme, attention: p.attention, contrast: p.contrast, density: p.density, textSize: p.textSize, motion: p.motion };
}
const GROUND = { light: "#f4f3ef", dark: "#111214" } as const;

/** The browser's bar colour for each system scheme: the ground the page will actually paint in it. */
export function themeColors(theme: Prefs["theme"]): { light: string; dark: string } {
  return theme === "system" ? GROUND : { light: GROUND[theme], dark: GROUND[theme] };
}

export function encodeUiCookie(b: UiBits): string {
  return [b.theme, b.attention, b.contrast, b.density, b.textSize, b.motion].join(".");
}
export function htmlAttrs(b: UiBits): Record<string, string> {
  return {
    "data-theme": b.theme,
    "data-attn": b.attention,
    "data-contrast": b.contrast,
    "data-density": b.density,
    "data-text": b.textSize,
    "data-motion": b.motion,
  };
}

export const SEARCH_ENGINES: Record<Exclude<Prefs["searchEngine"], "custom">, { name: string; url: string }> = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  google: { name: "Google", url: "https://www.google.com/search?q=%s" },
  kagi: { name: "Kagi", url: "https://kagi.com/search?q=%s" },
  brave: { name: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?q=%s" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=%s" },
};

/** Undoes a failed change: each key it set goes back to its earlier value, unless something newer has changed it since. */
export function undoPatch<T extends object>(current: T, patch: Partial<T>, before: T): T {
  const back = { ...current };
  for (const k of Object.keys(patch) as (keyof T)[]) if (Object.is(current[k], patch[k])) back[k] = before[k];
  return back;
}
