import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import { setScreenshotTime } from "./screenshot-time";

const mergeOptions = {
  projectId: ids.gitlab.projectId,
  iid: ids.gitlab.mergeRequestIid,
  title: "Improve pipeline retry diagnostics",
  state: "OPENED",
  sha: "5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  sourceBranch: "feature/retry-diagnostics",
  targetBranch: "main",
  mergeMethod: "merge",
  squashPolicy: "always",
  squash: true,
  removeSourceBranch: true,
  canRemoveSourceBranch: true,
  canMerge: false,
  canAutoMerge: true,
  canCancelAutoMerge: false,
  autoMergeEnabled: false,
  mergeBlockedReason: "The pipeline is still running.",
  autoMergeBlockedReason: null,
  mergeCommitMessage: null,
  squashCommitMessage: null,
  worktreeId: ids.worktrees.gitlabRetry,
  worktreeFolder: "/Users/acme/Repositories/platform-retry",
  canDeleteWorktree: true,
  ticketKey: "AIDE-145",
  ticketDoneStatusConfigured: true,
  defaultMoveTicketToDone: false,
  defaultDeleteWorktree: false,
  operation: null,
};

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
});

test("gitlab merge sheet shows project policy and deferred follow-ups", async ({
  page,
}, info) => {
  // Keep this visual/interaction verification read-only; provider behavior is covered by service tests.
  await page.route("**/api/graphql", async (route) => {
    const data = route.request().postDataJSON() as { query?: string };
    if (data.query?.includes("query GitLabMergeRequestMergeOptions")) {
      return route.fulfill({
        json: { data: { gitlabMergeRequestMergeOptions: mergeOptions } },
      });
    }
    await route.continue();
  });
  await page.goto(
    `/en/gitlab/merge-requests/${ids.gitlab.projectId}/${ids.gitlab.mergeRequestIid}`,
  );
  await page
    .getByRole("button", { name: "Merge options", exact: true })
    .click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("The pipeline is still running.")).toBeVisible();
  await expect(
    sheet.getByRole("checkbox", { name: "Squash commits", exact: true }),
  ).toBeDisabled();
  await expect(
    sheet.getByRole("button", { name: "Merge now", exact: true }),
  ).toBeDisabled();
  await expect(
    sheet.getByRole("button", { name: "Enable auto-merge", exact: true }),
  ).toBeEnabled();
  await expect(sheet.getByText(/AIDE-145/)).toBeVisible();
  await mkdir(`screenshots/${info.project.name}`, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: `screenshots/${info.project.name}/gitlab-merge-options.png`,
    fullPage: true,
  });
});

test("gitlab pipeline expands stages and retry history", async ({
  page,
}, info) => {
  await page.goto("/en/gitlab/pipelines");
  await page.getByRole("button", { name: /Show jobs for #118/ }).click();
  await expect(
    page.getByText("unit-tests", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show retry history", exact: true })
    .click();
  await expect(page.getByText("Retry history", { exact: true })).toBeVisible();
  await mkdir(`screenshots/${info.project.name}`, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: `screenshots/${info.project.name}/gitlab-pipeline-details.png`,
    fullPage: true,
  });
});
