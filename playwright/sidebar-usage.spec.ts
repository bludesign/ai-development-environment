import { expect, test, type Locator, type Page } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { setScreenshotTime } from "./screenshot-time";

async function expectWithinViewport(page: Page, popup: Locator) {
  await expect(async () => {
    const bounds = await popup.boundingBox();
    const viewport = page.viewportSize()!;
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(7);
    expect(bounds!.y).toBeGreaterThanOrEqual(7);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 7);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 7);
  }).toPass();
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 740, height: 360 },
  { width: 1280, height: 800 },
]) {
  test(`sidebar usage fits ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.setExtraHTTPHeaders({
      Authorization: `Bearer ${screenshotSessionToken}`,
    });
    await setScreenshotTime(page);
    await page.goto("/en/dashboard/action-center");
    const mobile = viewport.width < 768;
    if (mobile) {
      await page
        .getByRole("button", { name: "Show navigation", exact: true })
        .click();
    }
    const trigger = page.getByRole("button", { name: /^Usage today/ });
    await trigger.click();
    const popup = page.locator('[data-slot="popover-content"]');
    await expect(
      popup.getByText("Usage over the last 7 days", { exact: true }),
    ).toBeVisible();
    await expect(
      popup.locator(".recharts-bar-rectangle").first(),
    ).toBeVisible();
    await expectWithinViewport(page, popup);
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await expect(trigger).toBeFocused();
    if (mobile) {
      await expect(
        page.getByRole("button", { name: "Close navigation", exact: true }),
      ).toBeVisible();
    }
    await trigger.click();
    const fullUsage = popup.getByRole("link", { name: "View full usage" });
    await fullUsage.scrollIntoViewIfNeeded();
    await expectWithinViewport(page, popup);
    await fullUsage.click();
    await expect(page).toHaveURL(/\/en\/ai\/usage$/);
    await expect(popup).toBeHidden();
    if (mobile) {
      await expect(
        page.getByRole("button", { name: "Show navigation", exact: true }),
      ).toBeVisible();
    }
  });
}
