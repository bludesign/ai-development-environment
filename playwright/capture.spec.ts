import { expect, test } from "@playwright/test";

import { routes } from "./routes";

/**
 * Captures one screenshot per route for the active Playwright project (viewport + color
 * scheme), and fails the route if the page did not actually render.
 *
 * The screenshot is always written before the assertions run, so a failing route still leaves
 * a PNG to diagnose from. Waiting stays lenient — a slow integration page that never reaches
 * network idle is captured anyway — but a page that 500s or throws is a real failure rather
 * than a green test over a screenshot of an error state.
 */
test.describe("app screenshots", () => {
  for (const route of routes) {
    test(route.name, async ({ page }, testInfo) => {
      // Uncaught exceptions and unhandled rejections. Collected rather than thrown from the
      // listener so they surface as an assertion after the screenshot is safely on disk.
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      if (route.initScript) await page.addInitScript(route.initScript);
      const response = await page.goto(`/en${route.path}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      // Give client-side GraphQL queries time to resolve, tolerating open subscriptions.
      await page
        .waitForLoadState("networkidle", { timeout: 15_000 })
        .catch(() => {});
      await page.waitForTimeout(800);

      await page.screenshot({
        path: `screenshots/${testInfo.project.name}/${route.name}.png`,
        fullPage: route.fullPage ?? true,
        animations: "disabled",
      });

      expect(
        response,
        `${route.path} produced no navigation response`,
      ).not.toBeNull();
      expect(
        response!.status(),
        `${route.path} returned HTTP ${response!.status()}`,
      ).toBeLessThan(400);
      expect(pageErrors, `${route.path} raised uncaught page errors`).toEqual(
        [],
      );
    });
  }
});
