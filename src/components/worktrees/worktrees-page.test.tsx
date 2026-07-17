import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import {
  displayedWorktreePath,
  WorktreesPage,
  worktreeChangeActionState,
} from "./worktrees-page";
import type { WorktreeOverview } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
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

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("displayedWorktreePath", () => {
  test("uses the full path without a base and outside a configured base", () => {
    expect(displayedWorktreePath("/Users/test/repo", null)).toBe(
      "/Users/test/repo",
    );
    expect(
      displayedWorktreePath("/Users/test/worktrees/repo", "/Users/test/repos"),
    ).toBe("/Users/test/worktrees/repo");
  });

  test("uses a relative path inside a configured base", () => {
    expect(
      displayedWorktreePath("/Users/test/repos/project", "/Users/test/repos"),
    ).toBe("project");
  });
});

describe("worktreeChangeActionState", () => {
  test("chooses stage, unstage, and disabled change actions", () => {
    expect(
      worktreeChangeActionState({
        hasStagedChanges: false,
        hasUnstagedChanges: false,
      }),
    ).toEqual({ hasChanges: false, stageOperation: "STAGE_ALL" });
    expect(
      worktreeChangeActionState({
        hasStagedChanges: true,
        hasUnstagedChanges: false,
      }),
    ).toEqual({ hasChanges: true, stageOperation: "UNSTAGE_ALL" });
    expect(
      worktreeChangeActionState({
        hasStagedChanges: true,
        hasUnstagedChanges: true,
      }),
    ).toEqual({ hasChanges: true, stageOperation: "STAGE_ALL" });
  });
});

describe("WorktreesPage", () => {
  beforeEach(() => {
    global.ResizeObserver = ResizeObserverMock;
    window.history.replaceState(null, "", "/worktrees");
    window.localStorage.clear();
    navigation.push.mockReset();
    Element.prototype.scrollIntoView = vi.fn();
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockResolvedValue({
      worktreeOverview: {
        hiddenCount: 0,
        activeMoves: [],
        settings: {
          editorVariant: "CODE",
          updatedAt: new Date(0).toISOString(),
        },
        tags: [
          {
            id: "tag-1",
            name: "Ready",
            color: "green",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
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
                "worktree.inspect",
                "worktree.operation",
                "worktree.watch",
              ],
              baseRepoDirectory: "/workspaces",
              connectionStatus: "ONLINE",
              ipAddress: null,
              lastSeenAt: new Date().toISOString(),
              disconnectedAt: null,
              createdAt: new Date(0).toISOString(),
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
                  createdAt: new Date(0).toISOString(),
                  updatedAt: new Date(0).toISOString(),
                },
                codebase: {
                  id: "codebase-1",
                  folder: "/workspaces/repo",
                  observedOrigin: "git@github.com:openai/codex.git",
                  branch: "main",
                  headSha: "abc",
                  upstream: "origin/main",
                  ahead: 0,
                  behind: 0,
                  syncState: "IN_SYNC",
                  availability: "AVAILABLE",
                  statusError: null,
                  defaultBranch: "main",
                  remoteBranches: ["main"],
                  lastCheckedAt: new Date(0).toISOString(),
                  lastFetchedAt: new Date().toISOString(),
                  lastFetchAttemptAt: null,
                  lastFetchError: null,
                  createdAt: new Date(0).toISOString(),
                  updatedAt: new Date(0).toISOString(),
                },
                worktrees: [
                  {
                    id: "worktree-1",
                    codebaseId: "codebase-1",
                    gitDirectory: "/workspaces/repo/.git",
                    folder: "/workspaces/repo",
                    relativePath: ".",
                    primary: true,
                    branch: "feature/AIDE-24",
                    headSha: "abc",
                    upstream: "origin/feature/AIDE-24",
                    ahead: 0,
                    behind: 0,
                    syncState: "IN_SYNC",
                    baseBranch: "main",
                    baseBranchOverride: null,
                    baseAhead: 1,
                    baseBehind: 0,
                    hasStagedChanges: false,
                    hasUnstagedChanges: false,
                    pushStatus: "READY",
                    highlightColor: "blue",
                    availability: "AVAILABLE",
                    statusError: null,
                    ticketKey: "AIDE-24",
                    ticketTitle: "Add worktrees page",
                    ticketStatus: "In Progress",
                    pullRequest: {
                      id: "pull-request-1",
                      number: 17,
                      title: "Add worktrees page",
                      url: "https://github.com/openai/codex/pull/17",
                      repositoryGithubId: "repository-1",
                      repositoryNameWithOwner: "openai/codex",
                      repositoryUrl: "https://github.com/openai/codex",
                      labels: [],
                      jiraKey: "AIDE-24",
                      pipelineStatus: "NONE",
                      pipelines: [],
                      reviewDecision: "NONE",
                      unresolvedReviewThreadCount: 0,
                      createdAt: new Date(0).toISOString(),
                    },
                    tags: [
                      {
                        id: "tag-1",
                        name: "Ready",
                        color: "green",
                        createdAt: new Date(0).toISOString(),
                        updatedAt: new Date(0).toISOString(),
                      },
                    ],
                    activeJob: null,
                    lastCheckedAt: new Date().toISOString(),
                    missingAt: null,
                    createdAt: new Date(0).toISOString(),
                    updatedAt: new Date(0).toISOString(),
                  },
                ],
              },
            ],
          },
        ],
      },
    } as never);
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("renders the primary worktree card with Jira and tag metadata", async () => {
    render(<WorktreesPage />);
    expect(await screen.findByText("feature/AIDE-24")).toBeDefined();
    expect(screen.getByText("AIDE-24 — Add worktrees page")).toBeDefined();
    expect(
      screen.getByText("In Progress").closest('[data-slot="badge"]'),
    ).not.toBeNull();
    expect(screen.queryByText("Primary")).toBeNull();
    expect(screen.getByText("Ready")).toBeDefined();
    expect(
      screen.getByText("Ready").closest('[data-slot="badge"]')?.className,
    ).toContain("dark:text-green-300");
    expect(screen.getByText("repo")).toBeDefined();
    expect(screen.queryByText(".")).toBeNull();
    expect(screen.getByText("Yes").className).toContain(
      "dark:text-emerald-300",
    );
    expect(screen.getByText("Commits: 1")).toBeDefined();
    expect(screen.getByText("In sync")).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Sync" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Stash all" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Stage all" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("opens details from summary surfaces while the branch keeps inline expansion", async () => {
    render(<WorktreesPage />);
    const branchButton = await screen.findByRole("button", {
      name: "feature/AIDE-24",
    });
    const card = branchButton.closest('[data-slot="card"]');
    expect(card?.className).toContain("hover:bg-blue-500/20");
    expect(card?.className).toContain("hover:border-blue-500/50");
    expect(branchButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(branchButton);
    expect(branchButton.getAttribute("aria-expanded")).toBe("true");
    expect(navigation.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Path"));
    expect(navigation.push).toHaveBeenCalledWith("/worktrees/worktree-1");

    navigation.push.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "Table layout" }));
    const tableBranch = screen.getByRole("button", {
      name: "feature/AIDE-24",
    });
    const row = tableBranch.closest("tr");
    expect(row).not.toBeNull();
    expect(row?.className).toContain("hover:bg-blue-500/20");
    fireEvent.click(row!);
    expect(navigation.push).toHaveBeenCalledWith("/worktrees/worktree-1");

    navigation.push.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Customize worktree" }));
    expect(navigation.push).not.toHaveBeenCalled();
  });

  test("uses compact menu labels and the expanded bright color palette", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");

    const tagsTrigger = screen.getByRole("button", {
      name: "Tags: feature/AIDE-24",
    });
    expect(tagsTrigger.getAttribute("data-variant")).toBe("ghost");
    expect(tagsTrigger.className).toContain("focus-visible:ring");
    fireEvent.pointerDown(tagsTrigger, { button: 0, ctrlKey: false });
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="dropdown-menu-content"]'),
      ).toBeTruthy(),
    );

    const menu = document.querySelector('[data-slot="dropdown-menu-content"]')!;
    expect(menu.getAttribute("data-align")).toBe("start");
    const labels = menu.querySelectorAll('[data-slot="dropdown-menu-label"]');
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.className).toContain("items-center");
      expect(label.querySelector("svg")?.getAttribute("class")).toContain(
        "size-3",
      );
    }
    expect(
      menu.querySelector(
        '[data-slot="toggle-group-item"][aria-label="fuchsia"]',
      ),
    ).toBeTruthy();
    expect(
      menu.querySelector(
        '[data-slot="toggle-group-item"][aria-label="fuchsia"]',
      )?.className,
    ).toContain("bg-fuchsia-500");
  });

  test("keeps the change branch popover open with an agent-relative path", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Tags: feature/AIDE-24" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Change branch" }),
    );

    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="dropdown-menu-content"]'),
      ).toBeNull();
      const popover = document.querySelector('[data-slot="popover-content"]');
      expect(popover).toBeTruthy();
      expect(popover?.querySelector("p")?.textContent).toBe("repo");
    });
    expect(
      screen.getByRole("heading", { name: "Change branch" }),
    ).toBeDefined();
  });

  test("offers matching agents and warns about dirty existing destinations", async () => {
    const response = (await request("query Fixture")) as unknown as {
      worktreeOverview: WorktreeOverview;
    };
    const source = response.worktreeOverview.agents[0]!;
    source.agent.capabilities.push("worktree.move.push", "worktree.delete");
    const target = structuredClone(source);
    target.agent.id = "agent-2";
    target.agent.name = "Laptop";
    target.agent.hostname = "laptop.local";
    target.agent.capabilities = ["worktree.move.checkout", "worktree.delete"];
    target.codebases[0]!.codebase.id = "codebase-2";
    target.codebases[0]!.codebase.folder = "/workspaces/destination";
    target.codebases[0]!.worktrees[0]!.id = "worktree-2";
    target.codebases[0]!.worktrees[0]!.codebaseId = "codebase-2";
    target.codebases[0]!.worktrees[0]!.folder = "/workspaces/destination";
    target.codebases[0]!.worktrees[0]!.gitDirectory =
      "/workspaces/destination/.git";
    target.codebases[0]!.worktrees[0]!.branch = "main";
    target.codebases[0]!.worktrees[0]!.hasUnstagedChanges = true;
    response.worktreeOverview.agents.push(target);
    request.mockClear();

    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");
    fireEvent.pointerDown(
      screen.getAllByRole("button", { name: "Customize worktree" })[0]!,
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Move to agent" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Move to agent" }),
    ).toBeDefined();
    expect(screen.getByText("Laptop · Codex")).toBeDefined();
    fireEvent.click(
      screen.getByRole("combobox", { name: "Destination worktree" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: /main · \./ }));
    expect(
      await screen.findByText(/destination has uncommitted changes/i),
    ).toBeDefined();
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Delete old worktree after moving",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("confirms forced linked-worktree and optional remote deletion", async () => {
    const response = (await request("query Fixture")) as unknown as {
      worktreeOverview: WorktreeOverview;
    };
    const agent = response.worktreeOverview.agents[0]!;
    agent.agent.capabilities.push("worktree.delete");
    const group = agent.codebases[0]!;
    group.codebase.remoteBranches.push("feature/AIDE-24");
    group.worktrees[0]!.primary = false;
    request.mockClear();

    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Customize worktree" }),
      { button: 0, ctrlKey: false },
    );
    const deleteItem = await screen.findByRole("menuitem", {
      name: "Delete worktree",
    });
    expect(deleteItem.getAttribute("data-variant")).toBe("destructive");
    fireEvent.click(deleteItem);
    expect(
      await screen.findByRole("heading", { name: "Delete worktree" }),
    ).toBeDefined();
    expect(screen.getByText(/permanently lost/i)).toBeDefined();
    expect(
      screen.getByRole("checkbox", {
        name: "Also delete origin/feature/AIDE-24",
      }),
    ).toBeDefined();
  });

  test("uses shadcn items and color toggles in the tag manager dialog", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Tags: feature/AIDE-24" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Manage tags" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Manage tags" });
    expect(
      within(dialog).getByText("Ready").closest('[data-slot="item"]'),
    ).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    expect(within(dialog).getByRole("textbox")).toHaveProperty(
      "value",
      "Ready",
    );

    const fuchsia = within(dialog).getByRole("radio", { name: "fuchsia" });
    expect(fuchsia.getAttribute("data-slot")).toBe("toggle-group-item");
    fireEvent.click(fuchsia);
    expect(fuchsia.getAttribute("aria-checked")).toBe("true");
  });

  test("uses shadcn items and an empty state in the hidden worktrees dialog", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");
    request.mockResolvedValueOnce({
      hiddenWorktrees: [
        {
          id: "hidden-1",
          branch: "feature/hidden",
          folder: "/workspaces/hidden",
        },
      ],
    } as never);

    fireEvent.click(screen.getByRole("button", { name: "Hidden (0)" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Hidden worktrees",
    });
    expect(
      (await within(dialog).findByText("feature/hidden")).closest(
        '[data-slot="item"]',
      ),
    ).not.toBeNull();

    request.mockResolvedValueOnce({ purgeHiddenWorktree: true } as never);
    request.mockResolvedValueOnce({ hiddenWorktrees: [] } as never);
    fireEvent.click(within(dialog).getByRole("button", { name: "Purge" }));

    const emptyMessage = await within(dialog).findByText(
      "No hidden worktrees.",
    );
    expect(emptyMessage.closest('[data-slot="empty"]')).not.toBeNull();
  });

  test("opens pull request actions from the PR badge", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");

    fireEvent.pointerDown(screen.getByRole("button", { name: "PR #17" }), {
      button: 0,
      ctrlKey: false,
    });

    const github = await screen.findByRole("menuitem", {
      name: "Open in GitHub",
    });
    const details = screen.getByRole("menuitem", { name: "Open details" });
    expect(github.getAttribute("href")).toBe(
      "https://github.com/openai/codex/pull/17",
    );
    expect(github.getAttribute("target")).toBe("_blank");
    expect(details.getAttribute("href")).toContain(
      "/pull-requests/openai/codex/17",
    );
  });

  test("opens the Jira ticket drawer from the ticket key and title", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");

    fireEvent.click(
      screen.getByRole("button", {
        name: "AIDE-24 — Add worktrees page",
      }),
    );

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(new URLSearchParams(window.location.search).get("issue")).toBe(
      "AIDE-24",
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("query JiraTicket"),
        { issueKey: "AIDE-24" },
      ),
    );
  });

  test("opens the Jira ticket drawer from the ticket status badge", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");

    fireEvent.click(screen.getByRole("button", { name: "In Progress" }));

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(new URLSearchParams(window.location.search).get("issue")).toBe(
      "AIDE-24",
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("query JiraTicket"),
        { issueKey: "AIDE-24" },
      ),
    );
  });

  test("edits the base branch with an inline select", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");

    const editBase = screen.getByRole("button", { name: "Edit base branch" });
    const baseControl = editBase.parentElement!;
    expect(baseControl.querySelector('[role="combobox"]')).toBeNull();
    fireEvent.click(editBase);

    expect(
      baseControl.querySelector('[data-slot="select-trigger"]'),
    ).toBeTruthy();
    expect(await screen.findAllByRole("option")).toHaveLength(2);
  });

  test("toggles stacked commit and change tables from the commits badge", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");
    request.mockResolvedValueOnce({
      inspectWorktree: {
        commits: [
          {
            sha: "1234567890abcdef",
            subject: "Keep worktree details compact",
            authorName: "Codex",
            authoredAt: new Date(0).toISOString(),
            additions: 12,
            deletions: 3,
          },
        ],
        changes: [
          {
            path: "src/components/worktrees/worktrees-page.tsx",
            staged: true,
            unstaged: true,
            untracked: false,
            conflicted: false,
            stagedAdditions: 4,
            stagedDeletions: 1,
            unstagedAdditions: 2,
            unstagedDeletions: 0,
          },
        ],
        commitsTruncated: false,
        changesTruncated: false,
      },
    } as never);

    const commitsBadge = screen.getByRole("button", { name: "Commits: 1" });
    expect(commitsBadge.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(commitsBadge);

    expect(
      await screen.findByRole("table", { name: "Commits (1)" }),
    ).toBeDefined();
    expect(screen.getByRole("table", { name: "Changes (1)" })).toBeDefined();
    const detail = screen.getByTestId("worktree-detail");
    expect(detail.className).toContain("space-y-4");
    expect(detail.className).not.toContain("grid-cols-2");
    expect(screen.getByText("Keep worktree details compact")).toBeDefined();
    expect(
      screen.getByTitle("src/components/worktrees/worktrees-page.tsx"),
    ).toBeDefined();
    expect(
      screen.getByText("Staged").closest('[data-slot="badge"]'),
    ).toBeNull();
    expect(
      screen.getByText("Unstaged").closest('[data-slot="badge"]'),
    ).toBeNull();
    const tables = screen.getAllByRole("table");
    expect(
      tables.indexOf(screen.getByRole("table", { name: "Changes (1)" })),
    ).toBeLessThan(
      tables.indexOf(screen.getByRole("table", { name: "Commits (1)" })),
    );
    expect(commitsBadge.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(commitsBadge);
    expect(screen.queryByRole("table", { name: "Commits (1)" })).toBeNull();
  });

  test("refreshes the inspection for an expanded worktree", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");
    const overviewResponse = await request.mock.results[0]?.value;
    request.mockResolvedValueOnce({
      inspectWorktree: {
        commits: [],
        changes: [
          {
            path: "old-file.ts",
            staged: false,
            unstaged: true,
            untracked: false,
            conflicted: false,
            stagedAdditions: null,
            stagedDeletions: null,
            unstagedAdditions: 1,
            unstagedDeletions: 0,
          },
        ],
        commitsTruncated: false,
        changesTruncated: false,
      },
    } as never);
    fireEvent.click(screen.getByRole("button", { name: "feature/AIDE-24" }));
    expect(await screen.findByText("old-file.ts")).toBeDefined();

    request.mockResolvedValueOnce({ refreshWorktrees: 1 } as never);
    request.mockResolvedValueOnce(overviewResponse as never);
    request.mockResolvedValueOnce({
      inspectWorktree: {
        commits: [],
        changes: [
          {
            path: "new-file.ts",
            staged: true,
            unstaged: false,
            untracked: false,
            conflicted: false,
            stagedAdditions: 2,
            stagedDeletions: 1,
            unstagedAdditions: null,
            unstagedDeletions: null,
          },
        ],
        commitsTruncated: false,
        changesTruncated: false,
      },
    } as never);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("new-file.ts")).toBeDefined();
    expect(screen.queryByText("old-file.ts")).toBeNull();
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation RefreshWorktrees"),
    );
  });

  test("refreshes expanded details when live worktree activity arrives", async () => {
    const activityCallbacks: Array<() => void> = [];
    subscriptions.mockReturnValue({
      subscribe: vi.fn(
        (
          operation: { query: string },
          sink: { next: (value: unknown) => void },
        ) => {
          if (operation.query.includes("WorktreeInspectionChanged")) {
            activityCallbacks.push(() =>
              sink.next({
                data: {
                  worktreeInspectionChanged: {
                    worktreeId: "worktree-1",
                    branch: "feature/AIDE-24",
                    headSha: "def456",
                    upstream: "origin/feature/AIDE-24",
                    ahead: 1,
                    behind: 0,
                    syncState: "AHEAD",
                    baseAhead: 2,
                    baseBehind: 0,
                    hasStagedChanges: false,
                    hasUnstagedChanges: true,
                    observedAt: new Date().toISOString(),
                  },
                },
              }),
            );
          }
          return vi.fn();
        },
      ),
    } as never);
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");
    request.mockResolvedValueOnce({
      inspectWorktree: {
        commits: [],
        changes: [
          {
            path: "before-save.ts",
            staged: false,
            unstaged: true,
            untracked: false,
            conflicted: false,
            stagedAdditions: null,
            stagedDeletions: null,
            unstagedAdditions: 1,
            unstagedDeletions: 0,
          },
        ],
        commitsTruncated: false,
        changesTruncated: false,
      },
    } as never);
    fireEvent.click(screen.getByRole("button", { name: "feature/AIDE-24" }));
    expect(await screen.findByText("before-save.ts")).toBeDefined();
    await waitFor(() => expect(activityCallbacks).toHaveLength(1));

    request.mockResolvedValueOnce({
      inspectWorktree: {
        commits: [],
        changes: [
          {
            path: "after-save.ts",
            staged: false,
            unstaged: true,
            untracked: false,
            conflicted: false,
            stagedAdditions: null,
            stagedDeletions: null,
            unstagedAdditions: 2,
            unstagedDeletions: 0,
          },
        ],
        commitsTruncated: false,
        changesTruncated: false,
      },
    } as never);
    activityCallbacks[0]!();

    expect(await screen.findByText("after-save.ts")).toBeDefined();
    expect(screen.getByText("Dirty")).toBeDefined();
    expect(screen.getByRole("button", { name: "Commits: 2" })).toBeDefined();
    expect(screen.getByText("1 ahead")).toBeDefined();
    expect(screen.queryByText("before-save.ts")).toBeNull();
  });

  test("retries the live subscription after a transient error", async () => {
    let liveAttempts = 0;
    subscriptions.mockReturnValue({
      subscribe: vi.fn(
        (
          operation: { query: string },
          sink: { error: (value: unknown) => void },
        ) => {
          if (operation.query.includes("WorktreeInspectionChanged")) {
            liveAttempts += 1;
            if (liveAttempts === 1) {
              window.setTimeout(() => sink.error(new Error("temporary")), 0);
            }
          }
          return vi.fn();
        },
      ),
    } as never);
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");
    request.mockResolvedValueOnce({
      inspectWorktree: {
        commits: [],
        changes: [],
        commitsTruncated: false,
        changesTruncated: false,
      },
    } as never);
    fireEvent.click(screen.getByRole("button", { name: "feature/AIDE-24" }));
    expect(await screen.findByText("The worktree is clean.")).toBeDefined();

    await waitFor(() => expect(liveAttempts).toBe(2), { timeout: 2_500 });
  });

  test("switches to the compact table and remembers the choice", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");
    const tableLayout = screen.getByRole("radio", { name: "Table layout" });
    expect(tableLayout.getAttribute("data-slot")).toBe("toggle-group-item");
    fireEvent.click(tableLayout);
    await waitFor(() =>
      expect(window.localStorage.getItem("worktrees-layout")).toBe("table"),
    );
    expect(tableLayout.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("columnheader", { name: "Branch" })).toBeDefined();
  });
});
