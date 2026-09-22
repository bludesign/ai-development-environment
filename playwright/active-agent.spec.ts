import { expect, test } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import { setScreenshotTime } from "./screenshot-time";

test("global focus survives navigation and reload, then restores each page filter", async ({
  page,
  context,
}) => {
  await context.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
  await page.addInitScript((collectionId) => {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => collectionId,
    });
  }, ids.ccusageCollections.captured);
  await page.goto("/en/worktrees");
  const localAgent = page.getByRole("combobox", {
    name: "Filter by agent",
    exact: true,
  });
  await localAgent.click();
  await page.getByRole("option", { name: "Studio Mac", exact: true }).click();
  await expect(localAgent).toHaveText("Studio Mac");

  const globalAgent = page.getByRole("combobox", {
    name: "Active agent: None",
    exact: true,
  });
  await globalAgent.focus();
  await globalAgent.press("Enter");
  await page
    .getByPlaceholder("Search agents…", { exact: true })
    .fill("build-mac.local");
  await page.getByRole("option").filter({ hasText: "Build Mac" }).click();
  await expect(localAgent).toBeDisabled();
  await expect(localAgent).toHaveText("Build Mac");
  const searchInput = page.getByRole("searchbox", {
    name: "Search worktrees",
    exact: true,
  });
  const searchIcon = page
    .getByRole("search", { name: "Worktree filters", exact: true })
    .locator(".lucide-search");
  await expect
    .poll(async () => {
      const [inputBox, iconBox] = await Promise.all([
        searchInput.boundingBox(),
        searchIcon.boundingBox(),
      ]);
      if (!inputBox || !iconBox) return Number.POSITIVE_INFINITY;
      const inputCenter = inputBox.y + inputBox.height / 2;
      const iconCenter = iconBox.y + iconBox.height / 2;
      return Math.abs(inputCenter - iconCenter);
    })
    .toBeLessThanOrEqual(1);
  await page.reload();
  await expect(localAgent).toBeDisabled();
  await expect(localAgent).toHaveText("Build Mac");

  const secondTab = await context.newPage();
  await secondTab.goto("/en/worktrees");
  await expect(
    secondTab.getByRole("combobox", {
      name: "Active agent: Build Mac",
      exact: true,
    }),
  ).toBeVisible();

  await page.goto("/en/usage");
  const usageAgent = page.getByRole("combobox", {
    name: "Filter usage by agent",
    exact: true,
  });
  await expect(usageAgent).toBeDisabled();
  await expect(usageAgent).toHaveText("Build Mac");
  await page
    .getByRole("combobox", { name: "Active agent: Build Mac", exact: true })
    .click();
  await page.getByRole("option", { name: "None", exact: true }).click();
  await expect(usageAgent).toBeEnabled();
  await expect(usageAgent).toHaveText("All agents");
  await expect(
    secondTab.getByRole("combobox", {
      name: "Active agent: None",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    secondTab.getByRole("combobox", { name: "Filter by agent", exact: true }),
  ).toHaveText("Studio Mac");
  await page.goto("/en/worktrees");
  await expect(localAgent).toHaveText("Studio Mac");
  await expect(localAgent).toBeEnabled();
});
