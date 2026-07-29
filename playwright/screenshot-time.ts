import type { Page } from "@playwright/test";

/** The wall-clock instant every screenshot fixture and browser renders against. */
export const SCREENSHOT_TIME = "2026-01-28T09:41:00-05:00";

/** Pin the display zone too, so 9:41 AM stays 9:41 AM on every machine. */
export const SCREENSHOT_TIME_ZONE = "America/New_York";

/** Stable documentation origin used in place of the capture server's ephemeral port. */
export const SCREENSHOT_PUBLIC_ORIGIN = "https://ade.acme.example.com";

/** Freeze Date without pausing timers used to load and settle each page. */
export async function setScreenshotTime(page: Page): Promise<void> {
  await page.clock.setFixedTime(SCREENSHOT_TIME);
}

/**
 * Replaces origins rendered as documentation examples without changing where the browser sends
 * requests. The capture server intentionally uses a free port on every run, but that
 * implementation detail should not make otherwise identical PNGs differ.
 */
export async function normalizeScreenshotValues(page: Page): Promise<void> {
  await page.evaluate((stableOrigin) => {
    const runtimeOrigin = window.location.origin;
    if (runtimeOrigin === stableOrigin) return;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue?.includes(runtimeOrigin)) {
        node.nodeValue = node.nodeValue.replaceAll(runtimeOrigin, stableOrigin);
      }
    }
  }, SCREENSHOT_PUBLIC_ORIGIN);
}
