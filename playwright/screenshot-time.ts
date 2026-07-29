import type { Page } from "@playwright/test";

/** The wall-clock instant every screenshot fixture and browser renders against. */
export const SCREENSHOT_TIME = "2026-01-28T09:41:00-05:00";

/** Pin the display zone too, so 9:41 AM stays 9:41 AM on every machine. */
export const SCREENSHOT_TIME_ZONE = "America/New_York";

/** Freeze Date without pausing timers used to load and settle each page. */
export async function setScreenshotTime(page: Page): Promise<void> {
  await page.clock.setFixedTime(SCREENSHOT_TIME);
}
