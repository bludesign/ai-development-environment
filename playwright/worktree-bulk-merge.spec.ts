import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import { setScreenshotTime } from "./screenshot-time";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const accountSearchHead = "d36a9b0fa7c8223c1c24cd5633240223d595930d";
const offlineResultsHead = "8f26e41fb63d458e60e7918799fc537ee56279b1";
const accountSearch = {
  worktreeId: "bulk-search",
  repositoryName: "Customer Portal",
  agentName: "Mac Studio",
  branch: "feature/account-search",
  folder: "/workspaces/account-search",
  provider: "GITHUB",
  requestKey: "github:acme/customer-portal:42",
  requestNumber: 42,
  requestTitle: "Add account search",
  requestUrl: "https://github.com/acme/customer-portal/pull/42",
};
const offlineResults = {
  worktreeId: "bulk-offline",
  repositoryName: "Customer Portal",
  agentName: "Mac mini",
  branch: "feature/offline-results",
  folder: "/workspaces/offline-results",
  provider: "GITLAB",
  requestKey: "gitlab:example:17:19",
  requestNumber: 19,
  requestTitle: "Cache offline results",
  requestUrl: "https://gitlab.example.com/acme/portal/-/merge_requests/19",
};
const waiting = {
  ...accountSearch,
  worktreeId: "bulk-new-layout",
  branch: "feature/new-layout",
  folder: "/workspaces/new-layout",
  requestKey: "github:acme/customer-portal:43",
  requestNumber: 43,
  requestTitle: "Update the account layout",
  requestUrl: "https://github.com/acme/customer-portal/pull/43",
};
const defaultFollowUps = {
  canDeleteWorktree: true,
  defaultDeleteWorktree: false,
  ticketKey: null,
  defaultMoveTicketToDone: false,
  ticketDoneStatusConfigured: false,
  canSwitchToDefaultBranch: false,
  defaultSwitchToDefaultBranch: false,
  switchToDefaultBranchName: null,
  switchToDefaultBranchUnavailableReason: null,
  baseBranchUpdateOptions: null,
};
const candidates = [
  {
    ...accountSearch,
    repositoryNameWithOwner: "acme/customer-portal",
    projectId: null,
    reviewedHeadSha: accountSearchHead,
    reviewedTargetBranch: "main",
    blockedReason: null,
    githubOptions: {
      ...defaultFollowUps,
      worktreeId: accountSearch.worktreeId,
      worktreeFolder: accountSearch.folder,
      canMerge: true,
      defaultMethod: "SQUASH",
      availableMethods: ["SQUASH", "MERGE"],
      commitEmails: ["alex@acme.example"],
      defaultCommitEmail: "alex@acme.example",
      defaultCommitHeadline: "Add account search (#42)",
      defaultCommitBody: "",
      ticketKey: "AIDE-184",
      ticketDoneStatusConfigured: true,
      defaultMoveTicketToDone: true,
    },
    gitlabOptions: null,
  },
  {
    ...offlineResults,
    repositoryNameWithOwner: null,
    projectId: "17",
    reviewedHeadSha: offlineResultsHead,
    reviewedTargetBranch: "main",
    blockedReason: null,
    githubOptions: null,
    gitlabOptions: {
      ...defaultFollowUps,
      worktreeId: offlineResults.worktreeId,
      worktreeFolder: offlineResults.folder,
      canMerge: true,
      mergeMethod: "merge",
      squashPolicy: "default_off",
      squash: false,
      canRemoveSourceBranch: true,
      removeSourceBranch: true,
      mergeCommitMessage: null,
      squashCommitMessage: null,
    },
  },
  {
    ...waiting,
    repositoryNameWithOwner: "acme/customer-portal",
    projectId: null,
    reviewedHeadSha: null,
    reviewedTargetBranch: "main",
    blockedReason: "Required checks are still running.",
    githubOptions: null,
    gitlabOptions: null,
  },
];

for (const appId of [null, ids.apps.customerPortal]) {
  test(`Bulk Merge reviews settings and restores results on ${appId ? "app" : "global"} Worktrees`, async ({
    page,
  }, info) => {
    await page.setExtraHTTPHeaders({
      Authorization: `Bearer ${screenshotSessionToken}`,
    });
    await setScreenshotTime(page);
    let submitted = false;
    let complete = false;
    const batch = () => ({
      id: "bulk-merge-batch",
      appId,
      agentId: null,
      status: complete ? "COMPLETED" : "ACTIVE",
      createdAt: "2026-01-28T14:00:00Z",
      updatedAt: complete ? "2026-01-28T14:00:05Z" : "2026-01-28T14:00:00Z",
      finishedAt: complete ? "2026-01-28T14:00:05Z" : null,
      items: [
        {
          ...accountSearch,
          id: "merge-item-search",
          status: complete ? "MERGED" : "SUBMITTING",
          error: null,
          postMergeError: complete
            ? "Jira was unavailable. Retry the follow-up from Worktrees."
            : null,
        },
        {
          ...offlineResults,
          id: "merge-item-offline",
          status: complete ? "SKIPPED" : "PENDING",
          error: complete ? "The source commit changed after review." : null,
          postMergeError: null,
        },
      ],
    });
    await page.route("**/api/graphql", async (route) => {
      const { query, variables } = route.request().postDataJSON();
      const respond = (data: object) => route.fulfill({ json: { data } });
      if (query?.includes("query WorktreeMergeCandidates")) {
        expect(variables.appId ?? null).toBe(appId);
        return respond({
          worktreeMergeCandidates: submitted ? [candidates[2]] : candidates,
        });
      }
      if (query?.includes("query WorktreeMergeBatches")) {
        expect(variables.appId ?? null).toBe(appId);
        return respond({ worktreeMergeBatches: submitted ? [batch()] : [] });
      }
      if (query?.includes("query WorktreeMergeBatch(")) {
        return respond({ worktreeMergeBatch: submitted ? batch() : null });
      }
      if (query?.includes("mutation StartWorktreeMergeBatch")) {
        expect(variables.input).toMatchObject({
          appId,
          items: [
            {
              worktreeId: accountSearch.worktreeId,
              reviewedHeadSha: accountSearchHead,
              reviewedTargetBranch: "main",
              github: {
                method: "SQUASH",
                commitHeadline: "Ship account search",
                moveTicketToDone: true,
              },
            },
            {
              worktreeId: offlineResults.worktreeId,
              reviewedHeadSha: offlineResultsHead,
              gitlab: {
                sha: offlineResultsHead,
                removeSourceBranch: true,
                autoMerge: false,
              },
            },
          ],
        });
        submitted = true;
        return respond({ startWorktreeMergeBatch: batch() });
      }
      return route.continue();
    });

    await page.goto(
      appId
        ? `/en/dashboard/apps/${appId}?view=worktrees`
        : "/en/dashboard/worktrees",
    );
    if (appId) {
      await page
        .getByRole("searchbox", { name: "Search worktrees" })
        .fill("does-not-match");
    }
    await page.getByRole("button", { name: "Bulk Merge", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Bulk Merge" });
    const search = dialog.getByRole("checkbox", {
      name: "Select feature/account-search",
    });
    const offline = dialog.getByRole("checkbox", {
      name: "Select feature/offline-results",
    });
    await expect(search).not.toBeChecked();
    await expect(offline).not.toBeChecked();
    await expect(
      dialog.getByRole("checkbox", { name: "Select feature/new-layout" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Select all ready" }).click();
    await expect(search).toBeChecked();
    await expect(offline).toBeChecked();
    const edit = dialog.getByRole("button", {
      name: "Edit settings for feature/account-search",
    });
    await edit.click();
    const headline = dialog.getByRole("textbox", { name: "Commit message" });
    await expect(headline).toHaveValue("Add account search (#42)");
    await headline.fill("Ship account search");
    await edit.click();
    await expect(
      dialog.getByRole("region", { name: "Review selected merges" }),
    ).toBeVisible();
    if (!appId) {
      await mkdir(`screenshots/${info.project.name}`, { recursive: true });
      await page.mouse.move(2, 2);
      await page.screenshot({
        path: `screenshots/${info.project.name}/worktree-bulk-merge.png`,
        animations: "disabled",
      });
    }

    await dialog.getByRole("button", { name: "Merge 2 requests" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Bulk Merge running" }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();
    complete = true;
    await page.reload();
    await page.getByRole("button", { name: "Bulk Merge", exact: true }).click();
    await expect(
      dialog.getByRole("heading", { name: "Bulk Merge completed" }),
    ).toBeVisible();
    await expect(dialog.getByText("Merged", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("The source commit changed after review."),
    ).toBeVisible();
    await expect(
      dialog.getByText(/Follow-up warning: Jira was unavailable/),
    ).toBeVisible();
    await expect(
      dialog.getByText("Required checks are still running."),
    ).toBeVisible();
    if (!appId) {
      await page.mouse.move(2, 2);
      await dialog
        .getByRole("button", { name: "Close", exact: true })
        .first()
        .focus();
      await expect(
        page.locator('[data-slot="hover-card-content"]'),
      ).toHaveCount(0);
      await page.screenshot({
        path: `screenshots/${info.project.name}/worktree-bulk-merge-results.png`,
        animations: "disabled",
      });
    }
  });
}
