import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { Worktree } from "@/components/worktrees/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { RunWorktreeCards } from "./run-worktree-cards";

vi.mock("@/lib/control-plane-client", () => ({
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

vi.mock("@/components/commands/command-quick-actions", () => ({
  CommandQuickActions: () => null,
}));

vi.mock("@/components/workflows/workflow-quick-actions", () => ({
  WorkflowQuickActions: () => null,
}));

vi.mock("@/components/worktrees/worktree-detail-page", () => ({
  WORKTREE_DETAIL_OVERVIEW_QUERY:
    "query WorktreeDetailOverview($worktreeId: ID!, $buildFirst: Int = 50)",
  WorktreeBuildTable: ({
    builds,
    onLoadMore,
  }: {
    builds: Array<{ id: string }>;
    onLoadMore: () => Promise<void>;
  }) => (
    <div>
      <span>{`build-count:${builds.length}`}</span>
      <button onClick={() => void onLoadMore()} type="button">
        Load more builds
      </button>
    </div>
  ),
}));

vi.mock("@/components/worktrees/worktree-navigation", () => ({
  findWorktreeOverviewEntry: (overview: { entry?: unknown }) =>
    overview.entry ?? null,
  worktreeDetailHref: (worktreeId: string) =>
    `/dashboard/worktrees/${worktreeId}`,
}));

vi.mock("@/components/worktrees/worktrees-page", async (importOriginal) => ({
  BaseFreshnessBadge: () => null,
  OriginStatusBadges: () => null,
  PrimaryWorktreeActions: (
    await importOriginal<
      typeof import("@/components/worktrees/worktrees-page")
    >()
  ).PrimaryWorktreeActions,
  PullRequestBadges: (
    await importOriginal<
      typeof import("@/components/worktrees/worktrees-page")
    >()
  ).PullRequestBadges,
  displayedWorktreePath: (path: string) => path,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const entry = {
  agentGroup: {
    agent: {
      id: "agent-1",
      name: "Build Mac",
      hostname: "build-mac.local",
      capabilities: [],
      baseRepoDirectory: "/workspace",
    },
  },
  group: {
    quickActions: [],
    codebase: { id: "codebase-1", folder: "/workspace/repository" },
    repository: {
      id: "repository-1",
      name: "repository",
      displayOrigin: "github.com/example/repository",
    },
  },
  worktree: {
    id: "worktree-1",
    folder: "/workspace/repository-worktree",
    branch: "feature/test",
    baseBranch: "main",
    baseBranchOverride: null,
    headSha: "abcdef",
    upstream: "origin/feature/test",
    availability: "AVAILABLE",
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    pullRequest: null as Worktree["pullRequest"],
    sourceControlRequest: null as Worktree["sourceControlRequest"],
  },
};

describe("RunWorktreeCards", () => {
  let notifyBuildChanged: (() => void) | null;

  beforeEach(() => {
    request.mockReset();
    subscriptions.mockReset();
    notifyBuildChanged = null;
    subscriptions.mockReturnValue({
      subscribe: vi.fn(
        (
          operation: { query: string },
          sink: { next: (value: unknown) => void },
        ) => {
          if (operation.query.includes("RunWorktreeBuildsChanged")) {
            notifyBuildChanged = () =>
              sink.next({ data: { buildsChanged: { id: "build-new" } } });
          }
          return vi.fn();
        },
      ),
    } as never);
  });

  afterEach(() => cleanup());

  test.each(["GITHUB", "GITLAB"] as const)(
    "opens %s review details from a run worktree card",
    async (provider) => {
      const worktree = { ...entry.worktree };
      const url =
        provider === "GITHUB"
          ? "https://github.com/acme/repo/pull/42"
          : "https://gitlab.example/acme/repo/-/merge_requests/42";
      if (provider === "GITHUB")
        worktree.pullRequest = {
          id: "PR_42",
          number: 42,
          url,
          reviewDecision: "APPROVED",
          pipelineStatus: "NONE",
          pipelines: [],
          unresolvedReviewThreadCount: 0,
          labels: [],
          state: "OPEN",
          repositoryNameWithOwner: "acme/repo",
          repositoryGithubId: "repo-1",
          repositoryUrl: "https://github.com/acme/repo",
        } as unknown as NonNullable<Worktree["pullRequest"]>;
      else
        worktree.sourceControlRequest = {
          provider,
          id: "MR_42",
          number: 42,
          title: "Change",
          url,
          approvalState: "REVIEW_REQUIRED",
          state: "OPENED",
          isDraft: false,
          headRefName: "feature/test",
          headRefOid: "abc",
          createdAt: new Date(0).toISOString(),
        };
      request.mockImplementation(async (query) => {
        if (query.includes("query WorktreeDetailOverview"))
          return {
            worktreeOverview: {
              entry: { ...entry, worktree },
              agents: [
                { agent: entry.agentGroup.agent, codebases: [entry.group] },
              ],
            },
            builds: { items: [], nextCursor: null },
          } as never;
        if (query.includes("query WorktreeReviewStatus"))
          return {
            worktreeReviewStatus: {
              worktreeId: worktree.id,
              requestId: provider === "GITHUB" ? "PR_42" : "MR_42",
              provider,
              requestUrl: url,
              requestOpen: true,
              reviewers: [],
              currentReviewerIds: [],
              approvedReviewerIds: [],
              requirements: [],
              discoveryComplete: true,
              issues: [],
            },
          } as never;
        throw new Error(`Unexpected query: ${query}`);
      });
      render(<RunWorktreeCards worktreeId="worktree-1" />);
      const label = provider === "GITHUB" ? "PR #42" : "MR !42";
      fireEvent.click(
        await screen.findByRole("button", {
          name: `Review details for ${label}`,
        }),
      );
      expect(await screen.findByText("No approvals to show.")).toBeDefined();
      expect(
        screen
          .getByRole("link", { name: `Open ${label}` })
          .getAttribute("href"),
      ).toBe(url);
    },
  );

  test("refreshes every build row already loaded through pagination", async () => {
    const overviewVariables: unknown[] = [];
    let overviewRequests = 0;
    request.mockImplementation(async (query, variables) => {
      const operation = String(query);
      if (operation.includes("query WorktreeDetailOverview")) {
        overviewRequests += 1;
        overviewVariables.push(variables);
        const count = overviewRequests === 1 ? 50 : 60;
        return {
          worktreeOverview: {
            entry,
            agents: [
              { agent: entry.agentGroup.agent, codebases: [entry.group] },
            ],
          },
          builds: {
            items: Array.from({ length: count }, (_, index) => ({
              id: `build-${index}`,
            })),
            nextCursor: overviewRequests === 1 ? "cursor-50" : null,
          },
        } as never;
      }
      if (operation.includes("query RunWorktreeBuilds")) {
        return {
          builds: {
            items: Array.from({ length: 10 }, (_, index) => ({
              id: `build-${index + 50}`,
            })),
            nextCursor: null,
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });

    render(<RunWorktreeCards worktreeId="worktree-1" />);

    expect(await screen.findByText("build-count:50")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Load more builds" }));
    expect(await screen.findByText("build-count:60")).toBeDefined();

    expect(notifyBuildChanged).not.toBeNull();
    await act(async () => notifyBuildChanged?.());
    await waitFor(() => expect(overviewRequests).toBe(2));

    expect(overviewVariables.at(-1)).toEqual({
      worktreeId: "worktree-1",
      buildFirst: 60,
      includeCoverage: false,
      includeQueue: false,
    });
    expect(screen.getByText("build-count:60")).toBeDefined();
  });

  test.each([true, false])(
    "renders reviewer assignment from run worktree actions only when allowed: %s",
    async (allowed) => {
      const next = {
        ...entry,
        worktree: { ...entry.worktree, canAssignReviewers: allowed },
      };
      request.mockResolvedValue({
        worktreeOverview: {
          entry: next,
          agents: [{ agent: next.agentGroup.agent, codebases: [next.group] }],
        },
        builds: { items: [], nextCursor: null },
      } as never);
      render(<RunWorktreeCards worktreeId="worktree-1" />);
      await screen.findByText("build-count:0");
      const assign = screen.queryByRole("button", { name: "Assign reviewers" });
      if (allowed) {
        expect(assign).not.toBeNull();
        expect(assign!.hasAttribute("disabled")).toBe(false);
      } else expect(assign).toBeNull();
    },
  );
});
