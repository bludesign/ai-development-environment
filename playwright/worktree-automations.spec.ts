import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";
import type {
  Worktree,
  WorktreeCodebaseGroup,
  WorktreeOverview,
} from "../src/components/worktrees/types";
import { setScreenshotTime } from "./screenshot-time";

const updatedAt = "2026-10-27T12:00:00Z";

function automationWorktree(
  template: Worktree,
  provider: "GITHUB" | "GITLAB",
  managed: boolean,
): Worktree {
  const id = `${provider.toLowerCase()}-${managed ? "managed" : "native"}`;
  const branch = `feature/${
    provider === "GITHUB"
      ? managed
        ? "billing-sync"
        : "account-search"
      : managed
        ? "retry-diagnostics"
        : "offline-mode"
  }`;
  const number = managed ? 102 : 101;
  const title = managed
    ? "Improve background synchronization"
    : "Improve account search";
  const pullRequest = {
    ...template.pullRequest,
    id: `pull-request-${id}`,
    number,
    title,
    url: `https://github.com/acme/platform/pull/${number}`,
    repositoryGithubId: "platform-repository",
    repositoryNameWithOwner: "acme/platform",
    repositoryUrl: "https://github.com/acme/platform",
    labels: [],
    jiraKey: null,
    pipelineStatus: "SUCCESS",
    pipelineRevision: 1,
    pipelines: [],
    reviewDecision: "APPROVED",
    requestedReviewerCount: 0,
    unresolvedReviewThreadCount: 0,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeEnabled: !managed,
    viewerCanEnableAutoMerge: managed,
    viewerCanDisableAutoMerge: !managed,
    headRefOid: "head",
    headRefName: branch,
    createdAt: updatedAt,
  } as NonNullable<Worktree["pullRequest"]>;

  return {
    ...template,
    isDefaultBranch: false,
    defaultBranchUpdateEnabled: false,
    defaultBranchUpdatePaused: false,
    id,
    branch,
    folder: `/Users/acme/Repositories/${id}`,
    relativePath: id,
    gitDirectory: `/Users/acme/Repositories/platform/.git/worktrees/${id}`,
    primary: false,
    headSha: "head",
    upstream: `origin/${branch}`,
    ahead: 0,
    behind: 0,
    syncState: "IN_SYNC",
    pushStatus: "READY",
    baseBranch: "main",
    baseBehind: 0,
    baseAhead: 2,
    baseBranchOverride: null,
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    hasConflicts: false,
    rebaseInProgress: false,
    availability: "AVAILABLE",
    missingAt: null,
    activeJob: null,
    highlightColor: null,
    statusError: null,
    ticketKey: null,
    ticketTitle: null,
    ticketStatus: null,
    tags: [],
    latestBuild: null,
    autoSync: {
      worktreeId: id,
      state: "ACTIVE",
      conflictWorkflowId: null,
      conflictWorkflowChoice: null,
      lastError: null,
      pauseReason: null,
      lastSyncedAt: updatedAt,
      updatedAt,
    },
    autoMerge:
      provider === "GITHUB" && managed
        ? {
            worktreeId: id,
            autoSync: true,
            state: "WAITING_CI",
            repositoryNameWithOwner: "acme/platform",
            pullRequestNumber: number,
            branch,
            mergeMethod: "SQUASH",
            commitHeadline: title,
            commitBody: "",
            authorEmail: null,
            deleteWorktree: false,
            moveTicketToDone: false,
            ticketKey: null,
            lastError: null,
            updatedAt,
          }
        : null,
    pullRequest: provider === "GITHUB" ? pullRequest : null,
    sourceControlRequest:
      provider === "GITHUB"
        ? { ...pullRequest, provider }
        : {
            provider,
            id: `merge-request-${id}`,
            projectId: "42",
            number,
            title,
            url: `https://gitlab.example/acme/platform/-/merge_requests/${number}`,
            isDraft: false,
            headRefName: branch,
            headRefOid: "head",
            createdAt: updatedAt,
            state: "OPENED",
            worktreeId: id,
            detailedMergeStatus: "mergeable",
            mergeWhenPipelineSucceeds: !managed,
            mergeOperation: managed
              ? {
                  autoMerge: true,
                  autoSync: true,
                  state: "WAITING_CI",
                  worktreeId: id,
                }
              : null,
            reviewers: [],
            unresolvedDiscussionsCount: 0,
          },
    gitLabPipelines: [],
  };
}

function automationGroup(
  template: WorktreeCodebaseGroup,
  provider: "GITHUB" | "GITLAB",
): WorktreeCodebaseGroup {
  const host = provider === "GITHUB" ? "github.com" : "gitlab.example";
  return {
    ...template,
    codebase: {
      ...template.codebase,
      id: `${provider.toLowerCase()}-codebase`,
      availability: "AVAILABLE",
      statusError: null,
      activeJob: null,
      defaultBranch: "main",
      lastFetchError: null,
    },
    repository: {
      ...template.repository,
      id: `${provider.toLowerCase()}-repository`,
      name: provider === "GITHUB" ? "Platform (GitHub)" : "Platform (GitLab)",
      canonicalOrigin: `${host}/acme/platform`,
      displayOrigin: `https://${host}/acme/platform`,
    },
    worktrees: [false, true].map((managed) => ({
      ...automationWorktree(template.worktrees[0]!, provider, managed),
      codebaseId: `${provider.toLowerCase()}-codebase`,
    })),
    blockingJob: null,
    iosBuildConfigured: false,
    quickActions: [],
    mergeConflictQuickActions: [],
  };
}

test("active worktree automations stay green for native and managed merges on both providers", async ({
  page,
}, info) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
  await page.route("**/api/graphql", async (route) => {
    const { query } = route.request().postDataJSON();
    if (query?.includes("query WorktreeEnrichment"))
      return route.fulfill({
        json: {
          data: {
            worktreeEnrichment: { updates: [], durationMs: 10, warnings: [] },
          },
        },
      });
    if (query?.includes("query WorktreeOverview")) {
      const response = await route.fetch();
      const body = await response.json();
      const overview = body.data.worktreeOverview as WorktreeOverview;
      const template = overview.agents[0]!;
      overview.agents = [
        {
          agent: {
            ...template.agent,
            name: "Automation Mac",
            connectionStatus: "ONLINE",
            capabilities: [
              "worktree.auto-sync",
              "worktree.git",
              "worktree.branch",
            ],
          },
          codebases: ["GITHUB", "GITLAB"].map((provider) =>
            automationGroup(
              template.codebases[0]!,
              provider as "GITHUB" | "GITLAB",
            ),
          ),
        },
      ];
      overview.hiddenCount = 0;
      overview.activeMoves = [];
      overview.activeSyncBatches = [];
      return route.fulfill({ json: body });
    }
    await route.continue();
  });
  await page.goto("/en/dashboard/worktrees");
  for (const branch of [
    "feature/account-search",
    "feature/billing-sync",
    "feature/offline-mode",
    "feature/retry-diagnostics",
  ]) {
    const card = page
      .getByRole("button", { name: branch, exact: true })
      .locator('xpath=ancestor::*[@data-slot="card"][1]');
    const syncing = card.getByRole("button", {
      name: "Auto Syncing",
      exact: true,
    });
    const merging = card.getByRole("button", {
      name: "Auto Merging",
      exact: true,
    });
    for (const button of [syncing, merging]) {
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      await expect(button).toHaveClass(/bg-emerald-600/);
      expect(
        await button.evaluate((element) => {
          const context = document.createElement("canvas").getContext("2d")!;
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          const [red, green, blue, alpha] = context.getImageData(
            0,
            0,
            1,
            1,
          ).data;
          return { green: green > red && green > blue, opaque: alpha === 255 };
        }),
      ).toEqual({ green: true, opaque: true });
    }
    await expect(
      card.getByRole("button", { name: "Merge", exact: true }),
    ).toHaveCount(0);
    if (branch === "feature/account-search") {
      await mkdir(`screenshots/${info.project.name}`, { recursive: true });
      await card.screenshot({
        path: `screenshots/${info.project.name}/worktree-automations.png`,
        animations: "disabled",
      });
    }
  }
});

test("an idle conflict action leaves no extra space on a default branch card", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
  await page.route("**/api/graphql", async (route) => {
    const { query, variables } = route.request().postDataJSON();
    if (query?.includes("query WorktreeEnrichment"))
      return route.fulfill({
        json: {
          data: {
            worktreeEnrichment: { updates: [], durationMs: 10, warnings: [] },
          },
        },
      });
    if (query?.includes("WorkflowTargetSummaries"))
      return route.fulfill({
        json: {
          data: {
            workflowTargetSummaries: variables.targets.map(
              (target: object) => ({ ...target, activeRuns: [] }),
            ),
          },
        },
      });
    if (query?.includes("query WorktreeOverview")) {
      const response = await route.fetch();
      const body = await response.json();
      const overview = body.data.worktreeOverview as WorktreeOverview;
      const template = overview.agents[0]!;
      const group = automationGroup(template.codebases[0]!, "GITHUB");
      const worktree = group.worktrees[0]!;
      Object.assign(worktree, {
        branch: "main",
        isDefaultBranch: true,
        pullRequest: null,
        sourceControlRequest: null,
        autoSync: null,
        highlightColor: null,
      });
      group.worktrees = [worktree];
      group.mergeConflictQuickActions = [
        {
          id: "resolve-conflicts",
          name: "Resolve conflicts",
          description: "Resolve rebase conflicts",
          quickActionIconKey: "git-merge",
          quickActionButtonVariant: "secondary",
        },
      ];
      overview.agents = [{ ...template, codebases: [group] }];
      overview.hiddenCount = 0;
      overview.activeMoves = [];
      overview.activeSyncBatches = [];
      return route.fulfill({ json: body });
    }
    await route.continue();
  });
  await page.goto("/en/dashboard/worktrees");
  const card = page
    .getByRole("button", { name: "main", exact: true })
    .locator('xpath=ancestor::*[@data-slot="card"][1]');
  await expect(card.getByText("Default branch", { exact: true })).toBeVisible();
  await expect(card).toHaveClass(/bg-slate-500\/10/);
  await expect(
    card.getByRole("button", { name: "Resolve conflicts", exact: true }),
  ).toHaveCount(0);
  const content = card.locator('[data-slot="card-content"]');
  const dimensions = await content.evaluate((element) => {
    const hidden = element.querySelector(':scope > [data-slot="item"]');
    if (!hidden || getComputedStyle(hidden).display !== "none")
      throw new Error("Expected an empty hidden conflict item");
    const before = element.getBoundingClientRect().height;
    // Removing a hidden child must not change visible geometry. This catches
    // sibling-margin spacing retained on the preceding metadata element.
    hidden.remove();
    return { before, after: element.getBoundingClientRect().height };
  });
  expect(Math.abs(dimensions.before - dimensions.after)).toBeLessThan(1);
});
