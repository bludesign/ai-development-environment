import { expect, test } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { setScreenshotTime } from "./screenshot-time";

test("codebase tab filters remember independent choices and follow Active Agent", async ({
  page,
  context,
}) => {
  await context.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
  await page.goto("/en/dashboard/codebases");
  const localAgent = page.getByRole("combobox", {
    name: "Filter by agent",
    exact: true,
  });
  await localAgent.click();
  await page
    .getByPlaceholder("Search agents…", { exact: true })
    .fill("build-mac.local");
  await page.getByRole("option", { name: "Build Mac", exact: true }).click();
  await expect(page.getByText("No codebases match this agent.")).toBeVisible();

  await page.getByRole("tab", { name: "Branches", exact: true }).click();
  const branchAgent = page.getByRole("combobox", {
    name: "Agent",
    exact: true,
  });
  await expect(branchAgent).toHaveText("All agents");
  await branchAgent.click();
  await page.getByRole("option", { name: "Studio Mac", exact: true }).click();
  const rows = page.getByRole("table").getByRole("row");
  const allBranchRows = await rows.count();
  const author = page.getByRole("combobox", { name: "Author", exact: true });
  await author.click();
  await page.getByPlaceholder("Search authors…").fill("Priya");
  await page.getByRole("option", { name: "Priya Nair", exact: true }).click();
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all().then((items) => items.slice(1))) {
    await expect(row).toContainText("Priya Nair");
    await expect(row).toContainText("feature/archived-search");
  }
  await page
    .getByRole("checkbox", {
      name: "Select all matching eligible branches",
      exact: true,
    })
    .check();
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();

  await page
    .getByRole("combobox", { name: "Active agent: None", exact: true })
    .click();
  await page.getByRole("option").filter({ hasText: "Build Mac" }).click();
  await expect(branchAgent).toBeDisabled();
  await expect(branchAgent).toHaveText("Build Mac");
  await expect(
    page.getByText("No local branches match these filters."),
  ).toBeVisible();
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  await expect(author).toHaveText("Priya Nair");

  await page.reload();
  await expect(localAgent).toBeDisabled();
  await expect(localAgent).toHaveText("Build Mac");
  await page.getByRole("tab", { name: "Branches", exact: true }).click();
  await expect(branchAgent).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Active agent: Build Mac", exact: true })
    .click();
  await page.getByRole("option", { name: "None", exact: true }).click();
  await expect(branchAgent).toBeEnabled();
  await expect(branchAgent).toHaveText("Studio Mac");
  await expect(rows).toHaveCount(allBranchRows);
  await page.getByRole("tab", { name: "Agents", exact: true }).click();
  await expect(localAgent).toHaveText("Build Mac");
  await expect(localAgent).toBeEnabled();
  await expect(page.getByText("No codebases match this agent.")).toBeVisible();
});
