import { expect, test } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";

// Exercise the real server collection against the multi-project mock Jira site.
test("Jira All combines sources and keeps status selection through navigation and history", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await page.goto("/en/jira/tickets");
  await expect(
    page.getByRole("tab", { name: "All", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page
      .getByRole("main")
      .getByText("Improve deployment health checks", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /ACME-1234.*Add quick search/ }),
  ).toHaveCount(1);
  await page.getByRole("tab", { name: "In Progress", exact: true }).click();
  await expect(page).toHaveURL(/status=In\+Progress/);
  await expect(
    page
      .getByRole("main")
      .getByText("Review production incident runbook", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Board layout", exact: true }).click();
  await expect(
    page
      .getByRole("main")
      .getByText("Improve deployment health checks", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "ACME", exact: true }).click();
  await expect(
    page
      .getByRole("main")
      .getByText("Add quick search to the global navigation bar", {
        exact: true,
      }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "In Progress", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page
      .getByRole("main")
      .getByText("Improve deployment health checks", { exact: true }),
  ).toHaveCount(0);
  await page.goBack();
  await expect(
    page
      .getByRole("main")
      .getByText("Improve deployment health checks", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "In Review", exact: true }).click();
  await expect(
    page
      .getByRole("main")
      .getByText("Review production incident runbook", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "ACME", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "All statuses", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page).not.toHaveURL(/status=/);
  await page.getByRole("tab", { name: "All", exact: true }).click();
  const refresh = page.waitForResponse((response) =>
    (response.request().postData() ?? "").includes(
      "mutation RefreshAllJiraTickets",
    ),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await (await refresh).json()).errors).toBeUndefined();
  await expect(
    page
      .getByRole("main")
      .getByText("Improve deployment health checks", { exact: true }),
  ).toBeVisible();
});
