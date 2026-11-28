import { describe, expect, it } from "vitest";
import { encodeUiCookie, themeColors, uiBits, undoPatch } from "./prefs";
import { decodeUiCookie, defaultPrefs } from "./prefs-schema";

describe("themeColors", () => {
  it("follows the system scheme only when the theme does", () => {
    const system = themeColors("system");
    expect(system.light).not.toBe(system.dark);
  });

  it("paints the chosen ground whatever the system scheme, so a dark page never sits under a light bar", () => {
    expect(themeColors("dark")).toEqual({ light: themeColors("system").dark, dark: themeColors("system").dark });
    expect(themeColors("light")).toEqual({ light: themeColors("system").light, dark: themeColors("system").light });
  });

  it("reads the theme from the cookie the layout renders with, and falls back on a tampered one", () => {
    const dark = encodeUiCookie({ ...uiBits(defaultPrefs), theme: "dark" });
    expect(themeColors(decodeUiCookie(dark).theme).light).toBe(themeColors("dark").light);
    expect(decodeUiCookie("neon.yellow.x.y.z.w").theme).toBe(defaultPrefs.theme);
  });
});

type P = { theme: string; density: string; textSize: string; sidebarHidden: string[] };
const before: P = { theme: "system", density: "comfortable", textSize: "default", sidebarHidden: [] };

describe("undoPatch", () => {
  it("puts back only the keys the failed change set", () => {
    const now: P = { ...before, theme: "dark", density: "compact" };
    expect(undoPatch(now, { theme: "dark" }, before)).toEqual({ ...before, density: "compact" });
  });

  it("keeps a newer choice made while the failed one was on its way", () => {
    // Dark failed, but Light was chosen after it and is now showing.
    const now: P = { ...before, theme: "light" };
    expect(undoPatch(now, { theme: "dark" }, before)).toEqual(now);
  });

  it("compares arrays by identity, so a newer list with the same contents is kept", () => {
    const failed = ["apps"];
    const newer = ["apps"];
    const now: P = { ...before, sidebarHidden: newer };
    expect(undoPatch(now, { sidebarHidden: failed }, before).sidebarHidden).toBe(newer);
    expect(undoPatch({ ...before, sidebarHidden: failed }, { sidebarHidden: failed }, before).sidebarHidden).toBe(before.sidebarHidden);
  });

  it("does not change the state it was given", () => {
    const now: P = { ...before, textSize: "large" };
    undoPatch(now, { textSize: "large" }, before);
    expect(now.textSize).toBe("large");
  });
});
