import { expect, test } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";

test("filters disk-write diagnostics and expands the sampled call tree", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await page.goto("/debugging/crashes");
  await page.getByRole("combobox", { name: "Report type" }).click();
  await page.getByRole("option", { name: "Disk Writes" }).click();
  const diskReport = page.getByRole("row").filter({
    hasText: "No action taken",
    has: page.getByRole("link", { name: "AcmeApp", exact: true }),
  });
  await expect(diskReport).toBeVisible();
  await expect(
    page.getByText("EXC_BREAKPOINT · CartViewModel.item(at:)"),
  ).toHaveCount(0);
  await diskReport.getByRole("link", { name: "AcmeApp" }).click();

  await expect(
    page.getByRole("tab", { name: "Heaviest Stack" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("1,073.76 MB", { exact: true })).toBeVisible();
  await expect(page.getByText("1,446.33 kB/s", { exact: true })).toBeVisible();
  await expect(
    page.getByText("IndexStore.persistBatch()", { exact: true }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Sampled Call Tree" }).click();
  await page
    .getByRole("button", { name: "Expand libswift_Concurrency.dylib" })
    .click();
  await expect(
    page.getByRole("button", { name: "Expand SearchIndex.refresh()" }),
  ).toBeVisible();
});
