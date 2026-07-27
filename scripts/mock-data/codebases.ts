import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo, hoursAgo, minutesAgo } from "./time";

const BASE = "/Users/acme/Repositories";

/**
 * Highlight colors are Tailwind palette *names* (see COLORS in
 * src/components/worktrees/worktrees-page.tsx), not hex — the UI maps the stored value
 * through the class records in src/lib/worktree-highlight.ts, so a hex value silently
 * renders unhighlighted. Every worktree gets one so the accent stripe is visible on each
 * page that surfaces a worktree: primary checkouts green, feature branches purple/blue.
 *
 * Records that snapshot a worktree's color when they are created — notifications, for one —
 * import this map so the copy stays in step with the worktree it came from.
 */
export const HIGHLIGHTS = {
  webMain: "green",
  webFeature: "purple",
  iosMain: "green",
  apiFeature: "blue",
} as const;

export async function seedCodebases(prisma: PrismaClient): Promise<void> {
  await prisma.codebaseRepository.createMany({
    data: [
      {
        id: ids.repositories.web,
        canonicalOrigin: "github.com/acme/web-app",
        displayOrigin: "github.com/acme/web-app",
        name: "web-app",
        description: "Acme customer web application (Next.js).",
        createdAt: daysAgo(120),
      },
      {
        id: ids.repositories.ios,
        canonicalOrigin: "github.com/acme/ios-app",
        displayOrigin: "github.com/acme/ios-app",
        name: "ios-app",
        description: "Acme iOS client application (Swift).",
        createdAt: daysAgo(110),
      },
      {
        id: ids.repositories.api,
        canonicalOrigin: "github.com/acme/api",
        displayOrigin: "github.com/acme/api",
        name: "api",
        description: "Acme platform API service.",
        createdAt: daysAgo(90),
      },
    ],
  });

  const branches = JSON.stringify(["main", "develop"]);
  await prisma.codebase.createMany({
    data: [
      {
        id: ids.codebases.web,
        repositoryId: ids.repositories.web,
        agentId: ids.agents.studio,
        folder: `${BASE}/web-app`,
        observedOrigin: "github.com/acme/web-app",
        branch: "main",
        headSha: "9f3c1a2b4d5e6f7089a1b2c3d4e5f60718293a4b",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        syncState: "IN_SYNC",
        availability: "AVAILABLE",
        defaultBranch: "main",
        localBranchesJson: branches,
        remoteBranchesJson: branches,
        lastCheckedAt: minutesAgo(3),
        lastFetchedAt: minutesAgo(3),
      },
      {
        id: ids.codebases.ios,
        repositoryId: ids.repositories.ios,
        agentId: ids.agents.studio,
        folder: `${BASE}/ios-app`,
        observedOrigin: "github.com/acme/ios-app",
        branch: "main",
        headSha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
        upstream: "origin/main",
        ahead: 2,
        behind: 0,
        syncState: "AHEAD",
        availability: "AVAILABLE",
        defaultBranch: "main",
        localBranchesJson: branches,
        remoteBranchesJson: branches,
        lastCheckedAt: minutesAgo(5),
        lastFetchedAt: minutesAgo(5),
      },
      {
        id: ids.codebases.api,
        repositoryId: ids.repositories.api,
        agentId: ids.agents.studio,
        folder: `${BASE}/api`,
        observedOrigin: "github.com/acme/api",
        branch: "develop",
        headSha: "abcdef0123456789abcdef0123456789abcdef01",
        upstream: "origin/develop",
        ahead: 0,
        behind: 3,
        syncState: "BEHIND",
        availability: "AVAILABLE",
        defaultBranch: "main",
        localBranchesJson: branches,
        remoteBranchesJson: branches,
        lastCheckedAt: minutesAgo(8),
        lastFetchedAt: minutesAgo(8),
      },
    ],
  });

  await prisma.worktree.createMany({
    data: [
      {
        id: ids.worktrees.webMain,
        codebaseId: ids.codebases.web,
        gitDirectory: `${BASE}/web-app/.git`,
        folder: `${BASE}/web-app`,
        relativePath: "web-app",
        primary: true,
        branch: "main",
        headSha: "9f3c1a2b4d5e6f7089a1b2c3d4e5f60718293a4b",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        syncState: "IN_SYNC",
        pushStatus: "READY",
        highlightColor: HIGHLIGHTS.webMain,
        availability: "AVAILABLE",
        lastCheckedAt: minutesAgo(3),
        createdAt: daysAgo(120),
      },
      {
        id: ids.worktrees.webFeature,
        codebaseId: ids.codebases.web,
        gitDirectory: `${BASE}/web-app-quick-search/.git`,
        folder: `${BASE}/web-app-quick-search`,
        relativePath: "web-app-quick-search",
        branch: "feature/quick-search",
        headSha: "5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
        upstream: "origin/feature/quick-search",
        ahead: 4,
        behind: 1,
        syncState: "DIVERGED",
        hasStagedChanges: true,
        hasUnstagedChanges: true,
        pushStatus: "DIVERGED",
        highlightColor: HIGHLIGHTS.webFeature,
        availability: "AVAILABLE",
        lastCheckedAt: minutesAgo(2),
        createdAt: daysAgo(6),
        pullRequestLookupOrigin: "github.com/acme/web-app",
        pullRequestLookupBranch: "feature/quick-search",
        pullRequestLookupAt: minutesAgo(2),
      },
      {
        id: ids.worktrees.iosMain,
        codebaseId: ids.codebases.ios,
        gitDirectory: `${BASE}/ios-app/.git`,
        folder: `${BASE}/ios-app`,
        relativePath: "ios-app",
        primary: true,
        branch: "main",
        headSha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
        upstream: "origin/main",
        ahead: 2,
        behind: 0,
        syncState: "AHEAD",
        pushStatus: "READY",
        highlightColor: HIGHLIGHTS.iosMain,
        availability: "AVAILABLE",
        lastCheckedAt: minutesAgo(5),
        createdAt: daysAgo(110),
      },
      {
        id: ids.worktrees.apiFeature,
        codebaseId: ids.codebases.api,
        gitDirectory: `${BASE}/api-feature-auth/.git`,
        folder: `${BASE}/api-feature-auth`,
        relativePath: "api-feature-auth",
        branch: "feature/oauth-device-flow",
        headSha: "708192a3b4c5d6e7f8091a2b3c4d5e6f70819293",
        upstream: "origin/feature/oauth-device-flow",
        ahead: 7,
        behind: 0,
        syncState: "AHEAD",
        hasUnstagedChanges: true,
        pushStatus: "READY",
        highlightColor: HIGHLIGHTS.apiFeature,
        availability: "AVAILABLE",
        lastCheckedAt: minutesAgo(6),
        createdAt: daysAgo(3),
      },
    ],
  });

  // Tag colors go through the same palette-name lookup as highlights, so they are names too.
  await prisma.worktreeTag.createMany({
    data: [
      { id: ids.worktreeTags.review, name: "In Review", color: "violet" },
      { id: ids.worktreeTags.ready, name: "Ready to Merge", color: "emerald" },
      { id: ids.worktreeTags.blocked, name: "Blocked", color: "red" },
    ],
  });

  await prisma.worktreeTagAssignment.createMany({
    data: [
      { worktreeId: ids.worktrees.webFeature, tagId: ids.worktreeTags.review },
      { worktreeId: ids.worktrees.apiFeature, tagId: ids.worktreeTags.ready },
    ],
  });

  await prisma.worktreePullRequest.createMany({
    data: [
      {
        worktreeId: ids.worktrees.webFeature,
        githubId: "PR_kwACME42",
        number: ids.pullRequests.number,
        title: "Add quick search to the global navigation bar",
        url: "https://github.com/acme/web-app/pull/42",
        repositoryGithubId: "R_kgACMEweb",
        repositoryNameWithOwner: "acme/web-app",
        repositoryUrl: "https://github.com/acme/web-app",
        labelsJson: JSON.stringify(["enhancement", "frontend"]),
        jiraKey: ids.jira.issueKey,
        reviewDecision: "REVIEW_REQUIRED",
        unresolvedReviewThreadCount: 2,
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        autoMergeEnabled: false,
        viewerCanEnableAutoMerge: true,
        viewerCanDisableAutoMerge: false,
        headRefOid: "5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
        headRefName: "feature/quick-search",
        githubCreatedAt: daysAgo(5),
      },
      {
        worktreeId: ids.worktrees.apiFeature,
        githubId: "PR_kwACME58",
        number: 58,
        title: "Implement OAuth 2.0 device authorization flow",
        url: "https://github.com/acme/api/pull/58",
        repositoryGithubId: "R_kgACMEapi",
        repositoryNameWithOwner: "acme/api",
        repositoryUrl: "https://github.com/acme/api",
        labelsJson: JSON.stringify(["backend"]),
        reviewDecision: "APPROVED",
        unresolvedReviewThreadCount: 0,
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        autoMergeEnabled: true,
        viewerCanEnableAutoMerge: false,
        viewerCanDisableAutoMerge: true,
        headRefOid: "708192a3b4c5d6e7f8091a2b3c4d5e6f70819293",
        headRefName: "feature/oauth-device-flow",
        githubCreatedAt: daysAgo(2),
      },
    ],
  });

  await prisma.worktreeAutoSync.create({
    data: {
      worktreeId: ids.worktrees.apiFeature,
      state: "ACTIVE",
      branch: "feature/oauth-device-flow",
      lastSyncedAt: hoursAgo(1),
    },
  });
}
