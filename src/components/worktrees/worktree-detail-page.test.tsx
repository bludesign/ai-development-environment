import {
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

import { WorktreeDetailPage } from "./worktree-detail-page";
import type { WorktreeDetail, WorktreeOverview } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));
vi.mock("./worktree-jobs", () => ({
  waitForWorktreeJob: vi.fn(async () => ({ status: "SUCCEEDED" })),
  waitForWorktreeMove: vi.fn(async () => ({
    id: "move-1",
    status: "SUCCEEDED",
    targetWorktreeId: "worktree-2",
  })),
}));

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
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
  useRouter: () => ({ push: navigation.push }),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function overview(
  overrides: {
    online?: boolean;
    worktrees?: WorktreeOverview["agents"][number]["codebases"][number]["worktrees"];
  } = {},
): WorktreeOverview {
  const now = new Date(0).toISOString();
  return {
    hiddenCount: 0,
    activeMoves: [],
    settings: { editorVariant: "CODE", updatedAt: now },
    tags: [
      {
        id: "tag-1",
        name: "Ready",
        color: "green",
        createdAt: now,
        updatedAt: now,
      },
    ],
    agents: [
      {
        agent: {
          id: "agent-1",
          name: "Studio Mac",
          hostname: "studio.local",
          version: "0.1.0",
          osVersion: "macOS",
          architecture: "arm64",
          capabilities: [
            "worktree.branch",
            "worktree.delete",
            "worktree.inspect",
            "worktree.operation",
            "worktree.watch",
          ],
          baseRepoDirectory: "/workspaces",
          connectionStatus: overrides.online === false ? "OFFLINE" : "ONLINE",
          ipAddress: null,
          lastSeenAt: now,
          disconnectedAt: null,
          createdAt: now,
        },
        codebases: [
          {
            repository: {
              id: "repository-1",
              canonicalOrigin: "github.com/openai/codex",
              displayOrigin: "github.com/openai/codex",
              name: "Codex",
              description: "",
              jiraBranchRegex: null,
              keepBaseBranchUpToDate: true,
              codebases: [],
              createdAt: now,
              updatedAt: now,
            },
            codebase: {
              id: "codebase-1",
              folder: "/workspaces/repo",
              observedOrigin: "git@github.com:openai/codex.git",
              branch: "main",
              headSha: "base-sha",
              upstream: "origin/main",
              ahead: 0,
              behind: 0,
              syncState: "IN_SYNC",
              availability: "AVAILABLE",
              statusError: null,
              defaultBranch: "main",
              localBranches: ["main", "feature/AIDE-43"],
              remoteBranches: ["main"],
              lastCheckedAt: now,
              lastFetchedAt: now,
              lastFetchAttemptAt: now,
              lastFetchError: null,
              agent: {} as never,
              activeJob: null,
            },
            worktrees: overrides.worktrees ?? [
              {
                id: "worktree-1",
                codebaseId: "codebase-1",
                gitDirectory: "/workspaces/repo/.git/worktrees/aide-43",
                folder: "/workspaces/repo-aide-43",
                relativePath: "repo-aide-43",
                primary: false,
                branch: "feature/AIDE-43",
                headSha: "1234567890abcdef",
                upstream: null,
                ahead: 2,
                behind: 0,
                syncState: "NO_UPSTREAM",
                baseBranch: "main",
                baseBranchOverride: null,
                baseAhead: 2,
                baseBehind: 0,
                hasStagedChanges: true,
                hasUnstagedChanges: true,
                pushStatus: "DIRTY",
                highlightColor: null,
                availability: "AVAILABLE",
                statusError: null,
                ticketKey: "AIDE-43",
                ticketTitle: "Worktree Details Page",
                ticketStatus: "In Progress",
                pullRequest: null,
                tags: [
                  {
                    id: "tag-1",
                    name: "Ready",
                    color: "green",
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
                activeJob: null,
                lastCheckedAt: now,
                missingAt: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        ],
      },
    ],
  };
}

const initialDetail: WorktreeDetail = {
  changes: [
    {
      path: "src/worktree-details.tsx",
      staged: true,
      unstaged: true,
      untracked: false,
      conflicted: false,
      stagedAdditions: 10,
      stagedDeletions: 2,
      unstagedAdditions: 3,
      unstagedDeletions: 1,
    },
  ],
  commits: [
    {
      sha: "abcdef1234567890",
      subject: "Add worktree details",
      authorName: "Codex",
      authoredAt: new Date(0).toISOString(),
      additions: 30,
      deletions: 4,
    },
  ],
  changesTruncated: false,
  commitsTruncated: false,
};

describe("WorktreeDetailPage", () => {
  beforeEach(() => {
    global.ResizeObserver = ResizeObserverMock;
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState(null, "", "/worktrees/worktree-1");
    navigation.push.mockReset();
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("renders management metadata and live commits and changes", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("WorktreeDetailOverview")) {
        return { worktreeOverview: overview() } as never;
      }
      if (query.includes("InspectWorktree")) {
        return { inspectWorktree: initialDetail } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<WorktreeDetailPage worktreeId="worktree-1" />);

    expect(
      await screen.findByRole("heading", { name: "feature/AIDE-43" }),
    ).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Back to worktrees" })
        .getAttribute("href"),
    ).toBe("/worktrees");
    expect(
      screen.getByRole("link", { name: "Codex" }).getAttribute("href"),
    ).toBe("/codebases/codebase-1");
    expect(screen.getByText("Studio Mac · studio.local")).toBeDefined();
    expect(screen.getByText("/workspaces/repo-aide-43")).toBeDefined();
    expect(screen.getByText("1234567890abcdef")).toBeDefined();
    expect(await screen.findByText("src/worktree-details.tsx")).toBeDefined();
    expect(screen.getByText("Add worktree details")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open in VS Code" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Customize worktree" }),
    ).toBeDefined();
  });

  test("keeps saved metadata read-only when the agent is offline", async () => {
    request.mockResolvedValue({
      worktreeOverview: overview({ online: false }),
    } as never);

    render(<WorktreeDetailPage worktreeId="worktree-1" />);

    expect(await screen.findByText(/The agent is offline/)).toBeDefined();
    expect(screen.getByText("/workspaces/repo-aide-43")).toBeDefined();
    expect(
      request.mock.calls.some(([query]) => query.includes("InspectWorktree")),
    ).toBe(false);
  });

  test("shows a not-found state for a missing worktree", async () => {
    request.mockResolvedValue({
      worktreeOverview: overview({ worktrees: [] }),
    } as never);

    render(<WorktreeDetailPage worktreeId="missing" />);

    expect(await screen.findByText("Worktree not found")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Back to worktrees" }),
    ).toBeDefined();
  });

  test("reloads when a sibling worktree in the displayed codebase changes", async () => {
    let overviewSink: { next: (value: unknown) => void } | undefined;
    subscriptions.mockReturnValue({
      subscribe: vi.fn(
        (
          operation: { query: string },
          sink: { next: (value: unknown) => void },
        ) => {
          if (operation.query.includes("WorktreeDetailChanged")) {
            overviewSink = sink;
          }
          return vi.fn();
        },
      ),
    } as never);
    request.mockImplementation(async (query) => {
      if (query.includes("WorktreeDetailOverview")) {
        return { worktreeOverview: overview() } as never;
      }
      if (query.includes("InspectWorktree")) {
        return { inspectWorktree: initialDetail } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<WorktreeDetailPage worktreeId="worktree-1" />);
    await screen.findByRole("heading", { name: "feature/AIDE-43" });
    await waitFor(() => expect(overviewSink).toBeDefined());
    const overviewRequestCount = () =>
      request.mock.calls.filter(([query]) =>
        query.includes("WorktreeDetailOverview"),
      ).length;
    const beforeEvents = overviewRequestCount();

    overviewSink!.next({
      data: {
        worktreeOverviewChanged: {
          worktreeId: "unrelated-worktree",
          codebaseId: "unrelated-codebase",
        },
      },
    });
    expect(overviewRequestCount()).toBe(beforeEvents);

    overviewSink!.next({
      data: {
        worktreeOverviewChanged: {
          worktreeId: "sibling-worktree",
          codebaseId: "codebase-1",
        },
      },
    });
    await waitFor(() => expect(overviewRequestCount()).toBe(beforeEvents + 1));
  });

  test("shows an inspection error while keeping management controls available", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("WorktreeDetailOverview")) {
        return { worktreeOverview: overview() } as never;
      }
      if (query.includes("InspectWorktree")) {
        throw new Error("Inspection failed");
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<WorktreeDetailPage worktreeId="worktree-1" />);

    expect(await screen.findByText("Inspection failed")).toBeDefined();
    expect(
      screen.getByText("Commits and changes could not be loaded."),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open in VS Code" }),
    ).toBeDefined();
  });

  test("returns to the overview after deleting the worktree", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("WorktreeDetailOverview")) {
        return { worktreeOverview: overview() } as never;
      }
      if (query.includes("InspectWorktree")) {
        return { inspectWorktree: initialDetail } as never;
      }
      if (query.includes("DeleteWorktree")) {
        return { deleteWorktree: { id: "job-delete" } } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<WorktreeDetailPage worktreeId="worktree-1" />);
    await screen.findByRole("heading", { name: "feature/AIDE-43" });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Customize worktree" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete worktree" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Delete worktree",
    });
    fireEvent.click(
      dialog.querySelector<HTMLButtonElement>(
        'button[data-variant="destructive"]',
      )!,
    );

    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/worktrees"),
    );
  });

  test("opens the destination details page after moving the worktree", async () => {
    const moveOverview = overview();
    const source = moveOverview.agents[0]!;
    source.agent.capabilities.push("worktree.move.push");
    const sourceWorktree = source.codebases[0]!.worktrees[0]!;
    sourceWorktree.hasStagedChanges = false;
    sourceWorktree.hasUnstagedChanges = false;
    sourceWorktree.pushStatus = "READY";
    sourceWorktree.upstream = "origin/feature/AIDE-43";
    const destination = structuredClone(source);
    destination.agent.id = "agent-2";
    destination.agent.name = "Laptop";
    destination.agent.hostname = "laptop.local";
    destination.agent.capabilities = ["worktree.move.checkout"];
    destination.codebases[0]!.codebase.id = "codebase-2";
    destination.codebases[0]!.codebase.folder = "/workspaces/laptop-repo";
    destination.codebases[0]!.worktrees = [];
    moveOverview.agents.push(destination);
    request.mockImplementation(async (query) => {
      if (query.includes("WorktreeDetailOverview")) {
        return { worktreeOverview: moveOverview } as never;
      }
      if (query.includes("InspectWorktree")) {
        return {
          inspectWorktree: { ...initialDetail, changes: [] },
        } as never;
      }
      if (query.includes("mutation MoveWorktree")) {
        return { moveWorktree: { id: "move-1" } } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<WorktreeDetailPage worktreeId="worktree-1" />);
    await screen.findByRole("heading", { name: "feature/AIDE-43" });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Customize worktree" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Move to agent" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Move to agent",
    });
    fireEvent.click(
      dialog.querySelector<HTMLButtonElement>(
        'button[data-variant="default"]',
      )!,
    );

    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/worktrees/worktree-2"),
    );
  });

  test("refreshes inspection after live activity and manual refresh", async () => {
    let inspection = initialDetail;
    let activitySink: { next: (value: unknown) => void } | undefined;
    subscriptions.mockReturnValue({
      subscribe: vi.fn(
        (
          operation: { query: string },
          sink: { next: (value: unknown) => void },
        ) => {
          if (operation.query.includes("WorktreeInspectionChanged")) {
            activitySink = sink;
          }
          return vi.fn();
        },
      ),
    } as never);
    request.mockImplementation(async (query) => {
      if (query.includes("WorktreeDetailOverview")) {
        return { worktreeOverview: overview() } as never;
      }
      if (query.includes("InspectWorktree")) {
        return { inspectWorktree: inspection } as never;
      }
      if (query.includes("RefreshWorktrees"))
        return { refreshWorktrees: 1 } as never;
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<WorktreeDetailPage worktreeId="worktree-1" />);
    expect(await screen.findByText("src/worktree-details.tsx")).toBeDefined();
    await waitFor(() => expect(activitySink).toBeDefined());

    inspection = {
      ...initialDetail,
      changes: [{ ...initialDetail.changes[0]!, path: "src/live-update.ts" }],
    };
    activitySink!.next({
      data: {
        worktreeInspectionChanged: {
          worktreeId: "worktree-1",
          branch: "feature/AIDE-43",
          headSha: "new-head",
          upstream: null,
          ahead: 2,
          behind: 0,
          syncState: "NO_UPSTREAM",
          baseAhead: 2,
          baseBehind: 0,
          hasStagedChanges: true,
          hasUnstagedChanges: true,
          pushStatus: "DIRTY",
          observedAt: new Date().toISOString(),
        },
      },
    });
    expect(await screen.findByText("src/live-update.ts")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          query.includes("RefreshWorktrees"),
        ),
      ).toBe(true),
    );
  });
});
