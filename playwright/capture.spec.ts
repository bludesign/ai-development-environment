import { expect, test, type Page } from "@playwright/test";

import { routes } from "./routes";
import {
  normalizeScreenshotValues,
  setScreenshotTime,
} from "./screenshot-time";
import { stubWorktreeAgent } from "./worktree-stub";
import { screenshotSessionToken } from "../scripts/mock-data/auth";

async function waitForVisualSettle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

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
      if (!route.anonymous) {
        await page.setExtraHTTPHeaders({
          Authorization: `Bearer ${screenshotSessionToken}`,
        });
      }
      // Uncaught exceptions and unhandled rejections. Collected rather than thrown from the
      // listener so they surface as an assertion after the screenshot is safely on disk.
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await setScreenshotTime(page);
      if (route.initScript) await page.addInitScript(route.initScript);
      if (route.stubWorktree) await stubWorktreeAgent(page);
      const readyResponse = route.readyGraphqlOperation
        ? page.waitForResponse(
            (candidate) =>
              candidate.url().endsWith("/api/graphql") &&
              (candidate.request().postData() ?? "").includes(
                route.readyGraphqlOperation!,
              ),
            { timeout: 45_000 },
          )
        : null;
      const response = await page.goto(`/en${route.path}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      // Give client-side GraphQL queries time to resolve, tolerating open subscriptions.
      await page
        .waitForLoadState("networkidle", { timeout: 15_000 })
        .catch(() => {});
      if (readyResponse) {
        const completedResponse = await readyResponse;
        await completedResponse.finished();
      }
      if (route.readyTexts?.length) {
        const terminalState = route.readyTexts
          .slice(1)
          .reduce(
            (locator, text) =>
              locator.or(page.getByText(text, { exact: true })),
            page.getByText(route.readyTexts[0]!, { exact: true }),
          );
        await terminalState.first().waitFor({
          state: "visible",
          timeout: 30_000,
        });
      }
      if (route.scrollTo) {
        await page
          .locator(route.scrollTo)
          .evaluate((element) =>
            element.scrollIntoView({ behavior: "instant", block: "center" }),
          );
      }
      if (route.clickButton) {
        await page.getByRole("button", { name: route.clickButton }).click();
        await page.getByRole("dialog").waitFor({ state: "visible" });
      }
      if (route.clickTab) {
        const tab = page.getByRole("tab", { name: route.clickTab });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
      }
      await waitForVisualSettle(page);
      await normalizeScreenshotValues(page);

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
      const capturedUrl = new URL(page.url());
      const expectedPath = route.path === "/" ? "/en" : `/en${route.path}`;
      expect(
        capturedUrl.pathname,
        `${route.path} redirected before capture`,
      ).toBe(new URL(expectedPath, capturedUrl.origin).pathname);
      expect(pageErrors, `${route.path} raised uncaught page errors`).toEqual(
        [],
      );
    });
  }
});
