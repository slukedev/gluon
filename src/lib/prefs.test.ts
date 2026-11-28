import { describe, expect, it } from "vitest";
import { encodeUiCookie, themeColors, uiBits } from "./prefs";
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
