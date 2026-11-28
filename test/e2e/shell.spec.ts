import { accessSync, constants, existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { actUntil, clickToOpen, expect, isPhone, open, openMainNav, test } from "./fixtures";

// Without root, Gluon can't read the host's fstab, so Storage can only show its error.
const fstabReadable = (() => {
  try {
    accessSync("/proc/1/root/etc/fstab", constants.R_OK);
    return true;
  } catch {
    return false;
  }
})();

// Without a Docker daemon, pages that read Docker show their fallback and log the failed request.
const dockerUp = existsSync("/var/run/docker.sock");
const DOCKER_NOISE = [/\/api\/apps\b/, /\/api\/terminal\/targets\b/, /react\.dev\/errors\/441/];
const expectedErrors = (errors: string[]) => (dockerUp ? errors : errors.filter((e) => !DOCKER_NOISE.some((re) => re.test(e))));

const pages: { path: string; heading: string }[] = [
  { path: "/", heading: "Home" },
  { path: "/apps", heading: "Apps" },
  { path: "/apps/store", heading: "Apps" },
  { path: "/apps/images", heading: "Apps" },
  { path: "/apps/volumes", heading: "Apps" },
  { path: "/apps/networks", heading: "Apps" },
  { path: "/apps/disk", heading: "Apps" },
  { path: "/apps/custom", heading: "Apps" },
  { path: "/apps/new", heading: "Make an app" },
  { path: "/files", heading: "Files" },
  { path: "/storage", heading: "Storage" },
  { path: "/network", heading: "Network" },
  { path: "/network/router", heading: "Router" },
  { path: "/sites", heading: "Sites" },
  { path: "/system", heading: "System" },
  { path: "/diagnostics", heading: "Diagnostics" },
  { path: "/terminal", heading: "Terminal" },
  { path: "/settings/appearance", heading: "Appearance" },
  { path: "/settings/home", heading: "Home page" },
  { path: "/settings/navigation", heading: "Sidebar & shortcuts" },
  { path: "/settings/formats", heading: "Clock, dates & units" },
  { path: "/settings/notifications", heading: "Notifications" },
  { path: "/settings/security", heading: "Security" },
  { path: "/settings/alerts", heading: "Alerts" },
  { path: "/settings/activity", heading: "Activity" },
  { path: "/settings/people", heading: "People" },
  { path: "/settings/server", heading: "Server" },
  { path: "/settings/integrations", heading: "Integrations" },
  { path: "/settings/updates", heading: "Updates" },
  { path: "/settings/about", heading: "About Gluon" },
];

test.describe("every page", () => {
  for (const { path, heading } of pages) {
    test(`${path} loads with its heading, no errors and no sideways scroll`, async ({ page, guard }) => {
      const res = await open(page, path);
      expect(res?.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`:\\d+${path}$`));

      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
      if (path === "/storage" && !fstabReadable) {
        // The drives can't be read, but the page keeps its tabs and offers a retry in place.
        await expect(main.getByRole("tablist", { name: "Storage sections" })).toBeVisible();
        const notice = main.getByRole("alert").filter({ hasText: "Couldn't read the drives" });
        await expect(notice).toBeVisible();
        const retry = notice.getByRole("button", { name: "Try again" });
        const asked = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/storage");
        await retry.click();
        expect((await asked).ok()).toBe(false);
        await expect(retry).toBeVisible();
      }
      if (path.startsWith("/settings/")) await expect(page.getByRole("heading", { level: 1 }), "one page title").toHaveCount(1);
      // Let the page's own data requests finish so their failures show up as console errors.
      await page.waitForLoadState("networkidle");

      const overflow = () => page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
      expect(await overflow(), "page is wider than the screen").toBeLessThanOrEqual(0);
      expect(expectedErrors(guard.consoleErrors)).toEqual([]);
    });
  }
});

const navLinks = [
  ["Home", "/"],
  ["Apps", "/apps"],
  ["Files", "/files"],
  ["Storage", "/storage"],
  ["Network", "/network"],
  ["Sites", "/sites"],
  ["System", "/system"],
  ["Diagnostics", "/diagnostics"],
  ["Terminal", "/terminal"],
  ["Settings", "/settings"],
] as const;

// A link can carry a live count: "Home 1 needs you", "Home 2 need you".
const linkName = (name: string) => new RegExp(`^${name}( \\d+ needs? you)?$`);

test("the main navigation reaches every section and marks the current one", async ({ page }) => {
  await open(page, "/diagnostics");
  const links = (await openMainNav(page)).getByRole("link");
  await expect(links).toHaveCount(navLinks.length);
  for (const [i, [name]] of navLinks.entries()) await expect(links.nth(i)).toHaveAccessibleName(linkName(name));

  for (const [name, path] of navLinks) {
    const nav = await openMainNav(page);
    await nav.getByRole("link", { name: linkName(name) }).click();
    await expect(page).toHaveURL(new RegExp(`:\\d+${path}$`));
    if (name !== "Storage") await expect(page.getByRole("main").getByRole("heading", { level: 1, name })).toBeVisible();
    // On phones the drawer gets out of the way once a section is picked.
    if (isPhone(page)) await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
    const current = (await openMainNav(page)).locator('a[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAccessibleName(linkName(name));
  }
});

test.describe("search", () => {
  async function openSearch(page: Page) {
    const palette = page.getByRole("dialog", { name: "Search" });
    if (isPhone(page)) {
      await clickToOpen(page.getByRole("banner").getByRole("button", { name: "Search" }), palette);
    } else {
      const button = page.getByRole("complementary").getByRole("button", { name: "Search" });
      await actUntil(button, () => page.keyboard.press("ControlOrMeta+k"), palette);
    }
    return palette;
  }

  test("finds a page by name and opens it with the keyboard", async ({ page }) => {
    await open(page, "/");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    const palette = await openSearch(page);
    const box = palette.getByRole("combobox", { name: "Search apps, files, settings and more" });
    await expect(box).toBeFocused();

    await box.fill("people");
    const best = palette.getByRole("group", { name: "Best match" }).getByRole("option");
    await expect(best).toHaveCount(1);
    await expect(best).toContainText("People");
    await expect(best).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings\/people$/);
    await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "People" })).toBeVisible();
    await expect(palette).toBeHidden();
  });

  test("arrow keys move the selection and Escape closes without going anywhere", async ({ page }) => {
    await open(page, "/sites");
    await expect(page.getByRole("heading", { level: 1, name: "Sites" })).toBeVisible();
    const palette = await openSearch(page);
    const options = palette.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(options.first()).not.toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(page).toHaveURL(/\/sites$/);
  });

  test("a search with no match says so", async ({ page }) => {
    await open(page, "/");
    const palette = await openSearch(page);
    await palette.getByRole("combobox").fill("zzqx nothing matches this");
    await expect(palette.getByRole("option")).toHaveCount(0);
    await expect(palette.getByRole("status")).not.toBeEmpty();
  });
});

test("at 320px wide no section scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const [name, path] of navLinks) {
    await open(page, path);
    await expect(page).toHaveURL(new RegExp(`:\\d+${path}$`));
    await expect(page.getByRole("main").getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");
    // The root keeps a stable scrollbar gutter on desktop, so its content can be narrower than the window but never wider.
    const root = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(root.scroll, `${path} is wider than the screen`).toBeLessThanOrEqual(root.client);
    const main = await page.getByRole("main").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(main.scroll, `${path} has content wider than the page`).toBe(main.client);
  }
});

test("on a phone, the link to the page already open closes the drawer and stays put", async ({ page }) => {
  test.skip(!isPhone(page), "the drawer is the phone navigation");
  await open(page, "/system");
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "System" })).toBeVisible();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  const current = (await openMainNav(page)).locator('a[aria-current="page"]');
  await expect(current).toHaveAccessibleName(linkName("System"));
  await current.tap();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(/:\d+\/system$/);

  // The drawer still opens afterwards, and another link still navigates.
  await (await openMainNav(page)).getByRole("link", { name: linkName("Sites") }).tap();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Sites" })).toBeVisible();
});

test.describe("not found", () => {
  test("an unknown address answers 404 with a way home", async ({ page }) => {
    const res = await open(page, "/no-such-page/at-all");
    expect(res?.status()).toBe(404);
    await expect(page).toHaveTitle(/^Not found · /);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: "Nothing here" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "page is wider than the screen").toBeLessThanOrEqual(0);
    await main.getByRole("link", { name: "Go to Home" }).click();
    await expect(page).toHaveURL(/:\d+\/$/);
    await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  });

  test("a missing item inside a section keeps the navigation around it", async ({ page }) => {
    const res = await open(page, "/sites/no-such-site");
    expect(res?.status()).toBe(404);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: "Nothing here" })).toBeVisible();
    await expect((await openMainNav(page)).getByRole("link", { name: linkName("Sites") })).toBeVisible();
    if (isPhone(page)) {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
    }
    await main.getByRole("link", { name: "Go to Home" }).click();
    await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  });
});
