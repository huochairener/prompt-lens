import { expect, test, type Page } from "@playwright/test";

function session(isAnonymous = false) {
  return {
    user: { id: "remembered-user", name: "Returning User", email: "returning@example.com", isAnonymous },
    session: { id: "remembered-session", token: "test-token", expiresAt: new Date(Date.now() + 86400000).toISOString() },
  };
}

async function mockApi(page: Page, currentSession: ReturnType<typeof session> | null) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path === "/api/auth/get-session" ? currentSession
      : path === "/api/analyze/models" ? { options: [], defaultId: null }
      : {};
    await route.fulfill({ json });
  });
}

for (const locale of ["zh", "en"]) {
  for (const width of [1440, 390]) {
    test(`returning user continues from the homepage: ${locale}, ${width}px`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 });
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, domain: "localhost", path: "/" }]);
      await mockApi(page, session());
      await page.goto("/");
      const continueLink = page.getByRole("link", { name: locale === "zh" ? "继续使用" : "Continue to workspace", exact: true }).last();
      await expect(continueLink).toHaveAttribute("href", "/dashboard");
      await expect(page.locator('a[href="/login"]')).toHaveCount(0);
      await continueLink.click();
      await expect(page).toHaveURL(/\/dashboard$/);
      await page.reload();
      await expect(page.getByRole("button", { name: locale === "zh" ? "退出登录" : "Log out", exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/dashboard$/);
    });
  }
}

test("opening the login page with a remembered account skips OAuth", async ({ page }) => {
  await mockApi(page, session());
  await page.goto("/login");
  await expect(page).toHaveURL(/\/dashboard$/);
});

for (const state of ["signed out", "anonymous"]) {
  test(`${state} visitors can still choose a login provider`, async ({ page, context }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: "zh", domain: "localhost", path: "/" }]);
    await mockApi(page, state === "anonymous" ? session(true) : null);
    await page.goto("/");
    await expect(page.getByRole("link", { name: "登录", exact: true }).first()).toHaveAttribute("href", "/login");
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "使用 Google 账号登录" })).toBeVisible();
    await expect(page.getByRole("button", { name: "使用 GitHub 账号登录" })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
}
