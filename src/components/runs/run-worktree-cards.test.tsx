import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { RunWorktreeCards } from "./run-worktree-cards";

vi.mock("@/lib/control-plane-client", () => ({
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
  worktreeDetailHref: (worktreeId: string) => `/worktrees/${worktreeId}`,
}));

vi.mock("@/components/worktrees/worktrees-page", () => ({
  BaseFreshnessBadge: () => null,
  OriginStatusBadges: () => null,
  PrimaryWorktreeActions: () => null,
  PullRequestBadges: () => null,
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
          worktreeOverview: { entry },
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
    });
    expect(screen.getByText("build-count:60")).toBeDefined();
  });
});
