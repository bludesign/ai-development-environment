import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { displayedWorktreePath, WorktreesPage } from "./worktrees-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

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

describe("WorktreesPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/worktrees");
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockResolvedValue({
      worktreeOverview: {
        hiddenCount: 0,
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
                "worktree.inspect",
                "worktree.operation",
                "worktree.watch",
              ],
              baseRepoDirectory: null,
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
                  createdAt: new Date(0).toISOString(),
                  updatedAt: new Date(0).toISOString(),
                },
                codebase: {
                  id: "codebase-1",
                  folder: "/repo",
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
                    gitDirectory: "/repo/.git",
                    folder: "/repo",
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
                    hasUnstagedChanges: false,
                    highlightColor: "blue",
                    availability: "AVAILABLE",
                    statusError: null,
                    ticketKey: "AIDE-24",
                    ticketTitle: "Add worktrees page",
                    ticketStatus: "In Progress",
                    pullRequest: null,
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
    expect(screen.getByText("/repo")).toBeDefined();
    expect(screen.queryByText(".")).toBeNull();
    expect(screen.getByText("Yes").className).toContain(
      "dark:text-emerald-300",
    );
    expect(screen.getByText("Commits: 1")).toBeDefined();
    expect(screen.getByText("In sync")).toBeDefined();
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

  test("edits the base branch with an inline select", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");

    expect(screen.queryByRole("combobox", { name: "Base branch" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit base branch" }));

    expect(document.querySelector('[data-slot="select-trigger"]')).toBeTruthy();
    expect(await screen.findAllByRole("option")).toHaveLength(2);
  });

  test("shows commits and changes as stacked compact tables", async () => {
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

    fireEvent.click(screen.getByText("feature/AIDE-24"));

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
    fireEvent.click(screen.getByText("feature/AIDE-24"));
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
    fireEvent.click(screen.getByText("feature/AIDE-24"));
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
    fireEvent.click(screen.getByText("feature/AIDE-24"));
    expect(await screen.findByText("The worktree is clean.")).toBeDefined();

    await waitFor(() => expect(liveAttempts).toBe(2), { timeout: 2_500 });
  });

  test("switches to the compact table and remembers the choice", async () => {
    render(<WorktreesPage />);
    await screen.findByText("feature/AIDE-24");
    fireEvent.click(screen.getByRole("button", { name: "Table layout" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("worktrees-layout")).toBe("table"),
    );
    expect(screen.getByRole("columnheader", { name: "Branch" })).toBeDefined();
  });
});
