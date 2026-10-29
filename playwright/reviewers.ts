import { expect, type Page } from "@playwright/test";

import { ids } from "../scripts/mock-data/ids";
import type {
  RepositoryCodeReviewers,
  WorktreeReviewerAssignment,
} from "../src/components/reviewers/types";

export type ReviewerCapture = {
  provider: "GITHUB" | "GITLAB";
  view: "settings" | "assignment";
};

/** Bounded reviewer fixtures keep captures independent of private team membership. */
export async function stubReviewerCapture(
  page: Page,
  capture: ReviewerCapture,
) {
  const gitlab = capture.provider === "GITLAB";
  const repositoryId = gitlab
    ? "repo-acme-gitlab-platform"
    : ids.repositories.web;
  const worktreeId = gitlab
    ? ids.worktrees.gitlabRetry
    : ids.worktrees.webFeature;
  const people = [
    {
      id: "alex",
      username: "alex-chen",
      name: "Alex Chen",
      avatarUrl: null,
      url: null,
    },
    {
      id: "priya",
      username: "priya-nair",
      name: "Priya Nair",
      avatarUrl: null,
      url: null,
    },
    {
      id: "mateo",
      username: "mateo-silva",
      name: "Mateo Silva",
      avatarUrl: null,
      url: null,
    },
  ];
  const settings: RepositoryCodeReviewers = {
    repositoryId,
    provider: capture.provider,
    ref: "main",
    defaultRef: "main",
    refs: ["main", "release"],
    pools: [
      {
        key: "platform",
        name: "Platform owners",
        kind: "CODEOWNERS",
        candidates: people,
        selectedReviewerIds: ["alex", "priya"],
        unavailableReviewerIds: [],
      },
      {
        key: "security",
        name: "Security approval",
        kind: "APPROVAL_RULE",
        candidates: people.slice(1),
        selectedReviewerIds: ["priya", "mateo"],
        unavailableReviewerIds: [],
      },
    ],
    issues: [],
    discoveryComplete: true,
  };
  const assignment: WorktreeReviewerAssignment = {
    worktreeId,
    requestId: `${capture.provider}:acme:42`,
    requestUrl: gitlab
      ? "https://gitlab.acme.example.com/gitlab/acme/platform/-/merge_requests/42"
      : "https://github.com/acme/web-app/pull/42",
    provider: capture.provider,
    requestOpen: true,
    authorId: "dana",
    reviewers: people,
    requirements: [
      {
        id: "platform",
        name: "Platform owners",
        poolKeys: ["platform"],
        requiredApprovals: 2,
        eligibleReviewerIds: ["alex", "priya", "mateo"],
        candidateReviewerIds: ["priya"],
        approvedReviewerIds: [],
        requestedReviewerIds: ["alex"],
      },
      {
        id: "security",
        name: "Security approval",
        poolKeys: ["security"],
        requiredApprovals: 1,
        eligibleReviewerIds: ["priya", "mateo"],
        candidateReviewerIds: ["priya", "mateo"],
        approvedReviewerIds: [],
        requestedReviewerIds: [],
      },
    ],
    currentReviewerIds: ["alex"],
    approvedReviewerIds: [],
    selectedReviewerIds: [],
    issues: [],
    discoveryComplete: true,
  };

  await page.route("**/api/graphql", async (route) => {
    const body = route.request().postDataJSON() as { query?: string };
    const query = body.query ?? "";
    if (query.includes("query RepositoryCodeReviewers")) {
      await route.fulfill({
        json: { data: { repositoryCodeReviewers: settings } },
      });
    } else if (query.includes("query WorktreeReviewerAssignment")) {
      await route.fulfill({
        json: { data: { worktreeReviewerAssignment: assignment } },
      });
    } else if (query.includes("query PreviewRandomWorktreeReviewers")) {
      await route.fulfill({
        json: {
          data: {
            previewRandomWorktreeReviewers: {
              ...assignment,
              selectedReviewerIds: ["priya"],
            },
          },
        },
      });
    } else if (query.includes("query WorktreeDetailOverview")) {
      const response = await route.fetch();
      const result = await response.json();
      for (const agent of result.data?.worktreeOverview?.agents ?? []) {
        for (const group of agent.codebases ?? []) {
          for (const worktree of group.worktrees ?? []) {
            if (worktree.id === worktreeId) worktree.canAssignReviewers = true;
          }
        }
      }
      await route.fulfill({ response, json: result });
    } else {
      await route.fallback();
    }
  });
}

export async function openReviewerCapture(
  page: Page,
  capture: ReviewerCapture,
) {
  if (capture.view === "settings") {
    await page
      .getByRole("tab", { name: "Code reviewers", exact: true })
      .click();
    await page
      .getByRole("checkbox", { name: "Choose alex-chen for Platform owners" })
      .waitFor();
  } else {
    await page
      .getByRole("button", { name: "Assign reviewers", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Random selection", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Assign selected (1)", exact: true })
      .waitFor();
    const picker = page.getByRole("dialog", {
      name: "Assign reviewers",
      exact: true,
    });
    await expect(picker).toBeInViewport({ ratio: 1 });
    await expect(
      picker.getByRole("heading", { name: "Assign reviewers", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(picker.getByPlaceholder("Search people…")).toBeInViewport({
      ratio: 1,
    });
    await expect(
      picker.getByRole("button", { name: "Assign selected (1)", exact: true }),
    ).toBeInViewport({ ratio: 1 });
  }
}
