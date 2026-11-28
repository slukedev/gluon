import type { Browser, Page, TestInfo } from "@playwright/test";
import { Secret, TOTP } from "otpauth";
import { expect, hydrated, newContext, newPerson, open, openAccountMenu, ownAddress, signedOut, signIn, test, uniqueName } from "./fixtures";

test.use({ storageState: signedOut, extraHTTPHeaders: async ({}, use, testInfo) => use(ownAddress(testInfo)) });

// Each test signs in to an account of its own: Gluon turns away a sign-in while another one
// to the same account is still being checked, and tests run in parallel.
async function account(browser: Browser, testInfo: TestInfo, role: "member" | "admin" = "member") {
  const person = { name: "Alex Rivera", username: uniqueName(testInfo, "alex"), password: "alex's long password", role };
  await (await newPerson(browser, testInfo, person)).close();
  return person;
}

/** An account with two-step sign-in on, and a way to read its authenticator. */
async function accountWithCode(browser: Browser, testInfo: TestInfo) {
  const person = { name: "Alex Rivera", username: uniqueName(testInfo, "alex"), password: "alex's long password" };
  const ctx = await newPerson(browser, testInfo, person);
  const reauth = await ctx.request.post("/api/auth/reauth", { data: { password: person.password } });
  expect(reauth.ok(), await reauth.text()).toBe(true);
  const begin = await ctx.request.post("/api/me/mfa", { data: { action: "begin" } });
  expect(begin.ok(), await begin.text()).toBe(true);
  const { secret, ticket } = (await begin.json()) as { secret: string; ticket: string };
  const totp = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) });
  const confirm = await ctx.request.post("/api/me/mfa", { data: { action: "confirm", secret, ticket, code: totp.generate() } });
  expect(confirm.ok(), await confirm.text()).toBe(true);
  await ctx.close();
  // Enrolment used the current step and a code works once, so sign-in takes the next one, inside the accepted drift.
  return { ...person, nextCode: () => totp.generate({ timestamp: Date.now() + 30_000 }) };
}

function signInResponse(page: Page) {
  return page.waitForResponse((r) => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
}

test("a wrong password is refused with a message, and the right one signs in", async ({ page, browser }, testInfo) => {
  const me = await account(browser, testInfo);
  await open(page, "/login");
  await signIn(page, me.username, "not the password");
  await expect(page.getByText("Wrong username or password.")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await signIn(page, me.username, me.password);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /, Alex\.$/ })).toBeVisible();
});

test("a code pasted with a space in the middle keeps all six digits and signs in", async ({ page, context, browser }, testInfo) => {
  const me = await accountWithCode(browser, testInfo);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, "/login");
  await signIn(page, me.username, me.password);
  await expect(page.getByRole("heading", { level: 1, name: "Enter your code" })).toBeVisible();

  const code = me.nextCode();
  await page.evaluate((text) => navigator.clipboard.writeText(text), `${code.slice(0, 3)} ${code.slice(3)}`);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/auth/mfa") && r.method() === "POST", { timeout: 10_000 });
  const box = page.getByLabel("6-digit code");
  await expect(box).toBeFocused();
  await page.keyboard.press("ControlOrMeta+V");
  // A full paste submits by itself; nothing is pressed after it.
  expect((await sent).postDataJSON()).toEqual({ code });
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
});

test("a reload while the code is asked for stays on the code, and Start over really starts over", async ({ page, browser }, testInfo) => {
  const me = await accountWithCode(browser, testInfo);
  await open(page, "/login");
  await signIn(page, me.username, me.password);
  const codeStep = page.getByRole("heading", { level: 1, name: "Enter your code" });
  await expect(codeStep).toBeVisible();

  await page.reload();
  await hydrated(page);
  await expect(codeStep).toBeVisible();
  await expect(page.getByLabel("Username")).toHaveCount(0);

  // The half-finished sign-in is dropped on the server, so a reload now asks for the password.
  const dropped = page.waitForResponse((r) => r.url().endsWith("/api/auth/logout") && r.ok());
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page.getByLabel("Username")).toBeVisible();
  await dropped;
  await page.reload();
  await hydrated(page);
  await expect(page.getByRole("heading", { level: 1, name: /^Sign in to / })).toBeVisible();
  await expect(codeStep).toHaveCount(0);

  await signIn(page, me.username, me.password);
  await expect(codeStep).toBeVisible();
  await page.reload();
  await hydrated(page);
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await page.keyboard.type(me.nextCode());
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
});

test("an inner page asks a signed-out visitor to sign in", async ({ page }) => {
  const res = await open(page, "/settings/people");
  expect(res?.ok()).toBe(true);
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fpeople$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Sign in to / })).toBeVisible();

  const api = await page.request.get("/api/people");
  expect(api.status()).toBe(401);
});

test("signing in after following a deep link returns to that page", async ({ page, browser }, testInfo) => {
  const me = await account(browser, testInfo, "admin");
  await open(page, "/settings/people?tab=access");
  await expect(page).toHaveURL(/\/login\?next=/);
  await signIn(page, me.username, me.password);
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible({ timeout: 5_000 });
  await expect(page).toHaveURL(/:\d+\/settings\/people\?tab=access$/);
});

test("a return path planted in the request is still checked", async ({ page }) => {
  // The proxy sets the header for every page, so what a browser sends is replaced, never followed.
  await page.setExtraHTTPHeaders({ "x-gluon-path": "//example.com/" });
  await open(page, "/system");
  await expect(page).toHaveURL(/\/login\?next=%2Fsystem$/);
});

test("pressing Sign in before the page's scripts arrive keeps what was typed, then signs in", async ({ page, browser }, testInfo) => {
  const me = await account(browser, testInfo);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/_next/static/**/*.js", async (route) => {
    await held;
    await route.continue();
  });
  const navigations: string[] = [];
  page.on("request", (r) => r.isNavigationRequest() && navigations.push(r.url()));
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").fill(me.username);
  await page.getByLabel("Password", { exact: true }).fill(me.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(500);
  expect(navigations, "the form didn't reload the page").toEqual([expect.stringMatching(/\/login$/)]);
  await expect(page.getByLabel("Username")).toHaveValue(me.username);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(me.password);

  release();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  expect(navigations.some((u) => u.includes(me.password) || u.includes(encodeURIComponent(me.password)))).toBe(false);
});

test("a sign-in turned away because another is being checked says so, and the message stays", async ({ page }) => {
  // Two sign-ins to one account can't be made to overlap on cue, so this one gets the server's answer for it.
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "signin_busy", message: "Another sign-in to this account is being checked. Try again in a moment.", details: { retryAfter: 1 } } }),
    }),
  );
  await open(page, "/login");
  await signIn(page, "someone", "a password");
  const message = page.getByText("Another sign-in to this account is being checked. Try again in a moment.");
  await expect(message).toBeVisible();
  await page.waitForTimeout(2_500);
  await expect(message).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

test("sign-in follows a same-site return path and ignores off-site ones", async ({ browser }, testInfo) => {
  const me = await account(browser, testInfo, "admin");
  for (const [next, landing] of [
    ["/settings/people", /:\d+\/settings\/people$/],
    ["https://example.com/", /^http:\/\/127\.0\.0\.1:\d+\/$/],
    ["//example.com/", /^http:\/\/127\.0\.0\.1:\d+\/$/],
  ] as const) {
    const ctx = await newContext(browser, testInfo, signedOut);
    const page = await ctx.newPage();
    await open(page, `/login?next=${encodeURIComponent(next)}`);
    await signIn(page, me.username, me.password);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 }).last()).toBeVisible();
    await expect(page, `next=${next}`).toHaveURL(landing);
    await ctx.close();
  }
});

test("signing out ends the session on the server, not just in the browser", async ({ page, context, browser }, testInfo) => {
  const me = await account(browser, testInfo);
  await open(page, "/login");
  await signIn(page, me.username, me.password);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  const session = (await context.cookies()).find((c) => c.name === "gluon_session");
  expect(session).toBeDefined();

  const menu = await openAccountMenu(page);
  await menu.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await open(page, "/system");
  await expect(page).toHaveURL(/\/login\?next=%2Fsystem$/);

  // The old cookie, replayed by hand, no longer works.
  const replay = await page.request.get("/api/me", { headers: { cookie: `gluon_session=${session!.value}` } });
  expect(replay.status()).toBe(401);
});

test("repeated wrong passwords lock that account's sign-in for a while", async ({ page, browser }, testInfo) => {
  const me = await account(browser, testInfo);
  await open(page, "/login");
  for (let i = 0; i < 5; i++) {
    const res = signInResponse(page);
    await signIn(page, me.username, `wrong ${i}`);
    expect((await res).status()).toBe(400);
    await expect(page.getByText("Wrong username or password.")).toBeVisible();
  }
  const res = signInResponse(page);
  await signIn(page, me.username, "wrong again");
  expect((await res).status()).toBe(429);
  await expect(page.getByText(/^Too many tries\. You can try again in 0:\d\d\.$/)).toBeVisible();
  const wait = page.getByRole("button", { name: /^Try again in 0:\d\d$/ });
  await expect(wait).toBeDisabled();

  // The countdown moves.
  const first = await wait.textContent();
  await expect(wait).not.toHaveText(first!);

  // Even the right password is turned away until the lock ends.
  const right = await page.request.post("/api/auth/login", { data: { username: me.username, password: me.password } });
  expect(right.status()).toBe(429);
  expect((await right.json()).error.details.retryAfter).toBeGreaterThan(1);
});
