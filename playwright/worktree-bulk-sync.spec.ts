import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import type { WorktreeSyncBatch } from "../src/components/worktrees/types";
import { setScreenshotTime } from "./screenshot-time";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

for (const [scope, path, appId] of [
  ["all", "/en/dashboard/worktrees", null],
  [
    "app",
    `/en/dashboard/apps/${ids.apps.customerPortal}?view=worktrees`,
    ids.apps.customerPortal,
  ],
] as const) {
  test(`${scope} worktrees Bulk Sync preserves selection and rediscovers background results`, async ({
    page,
  }, info) => {
    await page.setExtraHTTPHeaders({
      Authorization: `Bearer ${screenshotSessionToken}`,
    });
    await setScreenshotTime(page);
    let batch: WorktreeSyncBatch | null = null;
    let repositoryId: string = ids.repositories.web;
    let repositoryName = "Customer Portal";
    let agentId: string = ids.agents.studio;
    let agentName = "Studio Mac";
    let codebaseId: string = ids.codebases.web;
    let completed = false;
    let selectedIds: string[] = [];
    await page.route("**/api/graphql", async (route) => {
      const { query, variables } = route.request().postDataJSON();
      if (query?.includes("query WorktreeEnrichment")) {
        return route.fulfill({
          json: {
            data: {
              worktreeEnrichment: { updates: [], warnings: [], durationMs: 10 },
            },
          },
        });
      }
      if (query?.includes("query WorktreeOverview")) {
        const response = await route.fetch();
        const body = await response.json();
        const overview = body.data.worktreeOverview;
        const agentGroup = overview.agents[0];
        const group = agentGroup.codebases[0];
        repositoryId = group.repository.id;
        repositoryName = group.repository.name;
        agentId = agentGroup.agent.id;
        agentName = agentGroup.agent.name;
        codebaseId = group.codebase.id;
        agentGroup.agent.connectionStatus = "ONLINE";
        agentGroup.agent.capabilities = [
          ...agentGroup.agent.capabilities,
          "worktree.auto-sync",
        ];
        group.blockingJob = null;
        const base = {
          ...group.worktrees[0],
          baseBranch: "main",
          baseBehind: 3,
          availability: "AVAILABLE",
          missingAt: null,
          activeJob: null,
          hasStagedChanges: false,
          hasUnstagedChanges: false,
          hasConflicts: false,
          rebaseInProgress: false,
          ticketKey: "AIDE-184",
          ticketTitle: "Improve account search",
        };
        group.worktrees = [
          {
            ...base,
            id: "bulk-one",
            branch: "feature/account-search",
            upstream: "origin/feature/account-search",
            folder: "/workspaces/account-search",
            hasConflicts: completed,
            rebaseInProgress: completed,
          },
          {
            ...base,
            id: "bulk-two",
            branch: "feature/offline-support",
            upstream: "origin/feature/offline-support",
            folder: "/workspaces/offline-support",
          },
          {
            ...base,
            id: "bulk-dirty",
            branch: "feature/local-edits",
            upstream: "origin/feature/local-edits",
            folder: "/workspaces/local-edits",
            hasUnstagedChanges: true,
          },
        ];
        agentGroup.codebases = [group];
        overview.agents = [agentGroup];
        overview.activeSyncBatches = batch ? [batch] : [];
        overview.activeMoves = [];
        return route.fulfill({ json: body });
      }
      if (query?.includes("mutation StartWorktreeSyncBatch")) {
        selectedIds = variables.input.worktreeIds;
        batch = {
          id: "bulk-batch",
          status: "ACTIVE",
          appId,
          agentId: null,
          createdAt: "2026-10-27T12:00:00Z",
          updatedAt: "2026-10-27T12:00:00Z",
          finishedAt: null,
          items: [
            {
              id: "bulk-item",
              worktreeId: "bulk-one",
              codebaseId,
              agentId,
              agentName,
              repositoryId,
              repositoryName,
              branch: "feature/account-search",
              baseBranch: "main",
              folder: "/workspaces/account-search",
              ticketKey: "AIDE-184",
              ticketTitle: "Improve account search",
              baseBehind: 3,
              status: "RUNNING",
              jobId: "bulk-job",
              error: null,
              createdAt: "2026-10-27T12:00:00Z",
              startedAt: "2026-10-27T12:00:00Z",
              finishedAt: null,
            },
          ],
        };
        return route.fulfill({
          json: { data: { startWorktreeSyncBatch: batch } },
        });
      }
      if (query?.includes("query WorktreeSyncBatch")) {
        return route.fulfill({
          json: {
            data: {
              worktreeSyncBatch:
                completed && batch
                  ? {
                      ...batch,
                      status: "COMPLETED",
                      updatedAt: "2026-10-27T12:00:10Z",
                      finishedAt: "2026-10-27T12:00:10Z",
                      items: batch.items.map((item) => ({
                        ...item,
                        status: "ATTENTION_REQUIRED",
                        error:
                          "Resolve the rebase conflicts before syncing again.",
                        finishedAt: "2026-10-27T12:00:10Z",
                      })),
                    }
                  : batch,
            },
          },
        });
      }
      await route.continue();
    });
    await page.goto(path);
    await expect(
      page.getByText("feature/account-search", { exact: true }).first(),
    ).toBeVisible();
    await page
      .getByRole("searchbox", { name: "Search worktrees" })
      .fill("does-not-match");
    await expect(
      page.getByText("No matching worktrees", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Bulk Sync", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Bulk Sync", exact: true });
    await expect(
      sheet.getByRole("checkbox", { name: "Select feature/account-search" }),
    ).toBeChecked();
    await expect(
      sheet.getByRole("checkbox", { name: "Select feature/offline-support" }),
    ).toBeChecked();
    await expect(
      sheet.getByRole("checkbox", { name: "Select feature/local-edits" }),
    ).toBeDisabled();
    await expect(
      sheet.getByText("Stash or commit changes before syncing."),
    ).toBeVisible();
    await sheet
      .getByRole("checkbox", { name: "Select feature/offline-support" })
      .uncheck();
    await mkdir(`screenshots/${info.project.name}`, { recursive: true });
    await page.screenshot({
      path: `screenshots/${info.project.name}/worktree-bulk-sync-${scope}.png`,
      animations: "disabled",
    });
    const bounds = await sheet.boundingBox();
    expect(bounds?.width).toBe(Math.min(page.viewportSize()!.width, 672));
    await sheet.getByRole("button", { name: "Sync selected (1)" }).click();
    await expect(
      sheet.getByText("Bulk Sync running", { exact: true }),
    ).toBeVisible();
    expect(selectedIds).toEqual(["bulk-one"]);
    await sheet
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();
    completed = true;
    await page.reload();
    await page.getByRole("button", { name: "Bulk Sync", exact: true }).click();
    await expect(
      sheet.getByText("Needs attention", { exact: true }),
    ).toBeVisible();
    await expect(
      sheet.getByRole("checkbox", { name: "Select feature/account-search" }),
    ).toBeDisabled();
    await expect(
      sheet.getByText("Resolve the current rebase or conflicts first."),
    ).toBeVisible();
    await expect(
      sheet.getByRole("link", { name: "View job logs" }),
    ).toHaveAttribute("href", "/en/dashboard/jobs/bulk-job");
    await expect(
      sheet.getByRole("link", { name: "feature/account-search", exact: true }),
    ).toHaveAttribute("href", "/en/dashboard/worktrees/bulk-one");
    await page.screenshot({
      path: `screenshots/${info.project.name}/worktree-bulk-sync-${scope}-results.png`,
      animations: "disabled",
    });
  });
}
