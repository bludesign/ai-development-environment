import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import type { WorktreeOverview } from "../src/components/worktrees/types";
import { setScreenshotTime } from "./screenshot-time";

const destination = "release/2026.1";
const switchError = "Local changes would be overwritten by switching branches.";
const initialTime = "2026-01-28T14:41:00Z";
const finishTime = "2026-01-28T14:41:08Z";

const rows = [
  {
    worktreeId: "branch-search",
    codebaseId: "branch-studio-clone",
    agentName: "Studio Mac",
    sourceBranch: "feature/account-search",
    folder: "/workspaces/account-search",
    baseBranch: "main",
  },
  {
    worktreeId: "branch-offline-results",
    codebaseId: "branch-build-clone",
    agentName: "Build Mac",
    sourceBranch: "feature/offline-results",
    folder: "/workspaces/offline-results",
    baseBranch: "develop",
  },
  {
    worktreeId: "branch-staging",
    codebaseId: "branch-studio-clone",
    agentName: "Studio Mac",
    sourceBranch: "feature/staging",
    folder: "/workspaces/staging",
    baseBranch: "main",
  },
  {
    worktreeId: "branch-backup",
    codebaseId: "branch-studio-clone",
    agentName: "Studio Mac",
    sourceBranch: "maintenance/backup",
    folder: "/workspaces/backup",
    baseBranch: "main",
  },
] as const;

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

for (const appId of [null, ids.apps.customerPortal]) {
  test(`${appId ? "app" : "global"} Bulk Change Branch uses filtered rows and rediscovers results`, async ({
    page,
  }, info) => {
    await page.setExtraHTTPHeaders({
      Authorization: `Bearer ${screenshotSessionToken}`,
    });
    await setScreenshotTime(page);
    let submitted = false;
    let complete = false;
    const batch = () => ({
      id: "branch-batch",
      appId,
      agentId: null,
      branchName: destination,
      mode: "EXISTING",
      ticketKey: null,
      status: complete ? "COMPLETED" : "ACTIVE",
      createdAt: initialTime,
      updatedAt: complete ? finishTime : initialTime,
      finishedAt: complete ? finishTime : null,
      items: rows.slice(0, 2).map((row, index) => ({
        ...row,
        id: `branch-row-${index}`,
        repositoryName: "Customer Portal",
        status: complete ? (index === 0 ? "SUCCEEDED" : "FAILED") : "RUNNING",
        error: complete && index === 1 ? switchError : null,
        warning: null,
        jobId: `branch-job-${index}`,
      })),
    });

    await page.route("**/api/graphql", async (route) => {
      const { query, variables } = route.request().postDataJSON();
      const respond = (data: object) => route.fulfill({ json: { data } });
      if (query?.includes("query WorktreeOverview")) {
        const response = await route.fetch();
        const body: { data: { worktreeOverview: WorktreeOverview } } =
          await response.json();
        const overview = body.data.worktreeOverview;
        const agentGroup = overview.agents[0]!;
        const group = agentGroup.codebases[0]!;
        const worktree = group.worktrees[0]!;
        overview.agents = ([ids.agents.studio, ids.agents.build] as const).map(
          (agentId, index) => {
            const cloneRows =
              index === 0 ? [rows[0], rows[2], rows[3]] : [rows[1]];
            const { agentName, codebaseId, baseBranch } = cloneRows[0]!;
            return {
              agent: {
                ...agentGroup.agent,
                id: agentId,
                name: agentName,
                connectionStatus: "ONLINE",
                capabilities: ["worktree.branch"],
              },
              codebases: [
                {
                  ...group,
                  blockingJob: null,
                  repository: { ...group.repository, name: "Customer Portal" },
                  codebase: {
                    ...group.codebase,
                    id: codebaseId,
                    availability: "AVAILABLE",
                    branch: baseBranch,
                    defaultBranch: baseBranch,
                    localBranches: cloneRows.map((row) => row.sourceBranch),
                    remoteBranches: [baseBranch, destination],
                  },
                  worktrees: cloneRows.map((row) => ({
                    ...worktree,
                    id: row.worktreeId,
                    codebaseId,
                    folder: row.folder,
                    relativePath: row.folder.split("/").at(-1)!,
                    branch:
                      complete && row === rows[0]
                        ? destination
                        : row.sourceBranch,
                    baseBranch: row.baseBranch,
                    baseBranchOverride: null,
                    isDefaultBranch: false,
                    activeJob: null,
                    activeJobs: [],
                    blockingJob: null,
                    availability: "AVAILABLE",
                    missingAt: null,
                    hasConflicts: false,
                    rebaseInProgress: false,
                    hasStagedChanges: false,
                    hasUnstagedChanges: row === rows[1],
                    latestBuild: null,
                    autoMerge: null,
                    autoSync: null,
                    tags: [],
                    ticketKey: null,
                    ticketTitle: null,
                  })),
                },
              ],
            };
          },
        );
        overview.activeSyncBatches = [];
        overview.activeMoves = [];
        return route.fulfill({ json: body });
      }
      if (query?.includes("query WorktreeEnrichment")) {
        return respond({
          worktreeEnrichment: { updates: [], warnings: [], durationMs: 10 },
        });
      }
      if (query?.includes("query WorktreeBranchBatches(")) {
        return respond({ worktreeBranchBatches: submitted ? [batch()] : [] });
      }
      if (query?.includes("query WorktreeBranchBatch(")) {
        return respond({ worktreeBranchBatch: submitted ? batch() : null });
      }
      if (query?.includes("mutation StartWorktreeBranchBatch(")) {
        expect(variables.input).toMatchObject({
          appId,
          mode: "EXISTING",
          branchName: destination,
        });
        expect(variables.input.items).toHaveLength(2);
        expect(variables.input.items).toEqual(
          expect.arrayContaining(
            rows.slice(0, 2).map((row) => ({
              worktreeId: row.worktreeId,
              expectedBranch: row.sourceBranch,
              baseBranch: row.baseBranch,
            })),
          ),
        );
        submitted = true;
        return respond({ startWorktreeBranchBatch: batch() });
      }
      return route.continue();
    });

    await page.goto(
      appId
        ? `/en/dashboard/apps/${appId}?view=worktrees`
        : "/en/dashboard/worktrees",
    );
    await page
      .getByRole("searchbox", { name: "Search worktrees" })
      .fill("feature/");
    const open = page.getByRole("button", {
      name: "Bulk Change Branch",
      exact: true,
    });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Bulk Change Branch" });
    await dialog.getByRole("tab", { name: "Existing branch" }).click();
    await dialog.getByRole("combobox", { name: "Existing branch" }).click();
    await page.getByRole("option", { name: /^release\/2026\.1\b/ }).click();
    const search = dialog.getByRole("checkbox", {
      name: "Select feature/account-search",
    });
    const offline = dialog.getByRole("checkbox", {
      name: "Select feature/offline-results",
    });
    await expect(search).not.toBeChecked();
    await expect(offline).not.toBeChecked();
    await expect(
      dialog.getByRole("checkbox", { name: "Select maintenance/backup" }),
    ).toHaveCount(0);
    await search.click();
    await offline.click();
    await expect(
      dialog.getByRole("checkbox", { name: "Select feature/staging" }),
    ).toBeDisabled();

    const capture = async (suffix = "") => {
      if (appId) return;
      await mkdir(`screenshots/${info.project.name}`, { recursive: true });
      await page.mouse.move(2, 2);
      await page.screenshot({
        path: `screenshots/${info.project.name}/worktree-bulk-change-branch${suffix}.png`,
        animations: "disabled",
      });
    };
    await capture();
    await dialog
      .getByRole("button", { name: "Change branch on 2 worktrees" })
      .click();
    await expect(
      dialog.getByText("Bulk Change Branch running", { exact: true }),
    ).toBeVisible();

    complete = true;
    await page.reload();
    await expect(
      page.getByText("feature/staging", { exact: true }).first(),
    ).toBeVisible();
    await open.click();
    await expect(
      dialog.getByText("Bulk Change Branch completed", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Branch changed", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("Failed", { exact: true })).toBeVisible();
    await expect(dialog.getByText(switchError)).toBeVisible();
    await expect(page.locator('[data-slot="hover-card-content"]')).toHaveCount(
      0,
    );
    await capture("-results");
  });
}
