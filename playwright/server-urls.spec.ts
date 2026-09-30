import { expect, test } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
});

test("SSE columns follow content width and URL rows stay inside their cards", async ({
  page,
}) => {
  await page.goto("/en/sse");
  const grid = page.getByTestId("sse-endpoint-grid");
  await expect(grid).toBeVisible();
  await expect(grid.getByText("Proxy endpoint URL").first()).toBeVisible();
  for (const [width, columns] of [
    [350, 1],
    [700, 1],
    [800, 2],
    [1150, 3],
  ] as const) {
    await grid.evaluate((element, value) => {
      element.parentElement!.style.width = `${value}px`;
    }, width);
    await expect
      .poll(() =>
        grid.evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
      )
      .toBe(columns);
    for (const card of await grid.locator('[data-slot="card"]').all()) {
      expect(
        await card.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
  }
});

test("the two-line server selector supports keyboard choices", async ({
  page,
}) => {
  await page.goto("/en/settings");
  const selector = page.locator("#server-default");
  await expect(selector).toContainText("Local");
  await expect(selector).toContainText("http://");
  await selector.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: /Proxy/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^Local/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: /^Remote/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(selector).toContainText("Remote");
  await expect(selector).toContainText("https://");
});
