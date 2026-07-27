import { test } from "@playwright/test";

import { routes } from "./routes";

/**
 * Captures one screenshot per route for the active Playwright project (viewport + color
 * scheme). Navigation is resilient: it waits for the DOM and a short network-idle window but
 * still captures whatever rendered so a slow integration page never fails the whole run.
 */
test.describe("app screenshots", () => {
  for (const route of routes) {
    test(route.name, async ({ page }, testInfo) => {
      await page.goto(`/en${route.path}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      // Give client-side GraphQL queries time to resolve, tolerating open subscriptions.
      await page
        .waitForLoadState("networkidle", { timeout: 15_000 })
        .catch(() => {});
      await page.waitForTimeout(800);

      await page.screenshot({
        path: `docs/screenshots/${testInfo.project.name}/${route.name}.png`,
        fullPage: route.fullPage ?? true,
        animations: "disabled",
      });
    });
  }
});
