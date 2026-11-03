import { expect, test, type Locator } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";

test.use({ viewport: { width: 390, height: 844 } });

async function expectSingleRow(tabs: Locator) {
  await expect(tabs).toBeVisible();
  const layout = await tabs.evaluate((element) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    topOffsets: [...element.querySelectorAll('[role="tab"]')].map(
      (tab) => tab.getBoundingClientRect().top,
    ),
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1);
  expect(layout.overflowY).toBe("hidden");
  expect(
    Math.max(...layout.topOffsets) - Math.min(...layout.topOffsets),
  ).toBeLessThan(1);
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
});

test("Jira project tabs stay in one horizontally scrollable row on a phone", async ({
  page,
}) => {
  await page.goto("/en/jira/tickets");
  const tabs = page.getByRole("tablist", { name: "Jira projects" });
  await expectSingleRow(tabs);
  const last = tabs.getByRole("tab").last();
  await last.click();
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expectSingleRow(tabs);
});

test("crash detail tabs stay on one row and the final tab remains reachable", async ({
  page,
}) => {
  await page.goto(`/en/debugging/crashes/${ids.crashes.checkout}`);
  const raw = page.getByRole("tab", { name: "Report text", exact: true });
  const tabs = page.getByRole("tablist").filter({ has: raw });
  await expectSingleRow(tabs);
  await raw.click();
  await expect(raw).toHaveAttribute("aria-selected", "true");
  await expectSingleRow(tabs);
});
