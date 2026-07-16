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

import { WorktreesPage } from "./worktrees-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

describe("WorktreesPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
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
              capabilities: ["worktree.inspect", "worktree.operation"],
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
                    highlightColor: "blue",
                    availability: "AVAILABLE",
                    statusError: null,
                    ticketKey: "AIDE-24",
                    ticketTitle: "Add worktrees page",
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
    expect(screen.getByText("Primary")).toBeDefined();
    expect(screen.getByText("Ready")).toBeDefined();
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
