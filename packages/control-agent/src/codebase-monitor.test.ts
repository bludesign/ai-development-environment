import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./handlers/codebases.js", () => ({
  inspectCodebase: vi.fn(),
  updateBaseBranchAfterFetch: vi.fn(),
}));
vi.mock("./handlers/worktrees.js", () => ({ discoverWorktrees: vi.fn() }));
vi.mock("./capture-command.js", () => ({ captureCommand: vi.fn() }));

import { captureCommand } from "./capture-command.js";
import { CodebaseMonitor } from "./codebase-monitor.js";
import type { AgentGraphQLClient } from "./graphql-client.js";
import {
  inspectCodebase,
  updateBaseBranchAfterFetch,
} from "./handlers/codebases.js";
import { discoverWorktrees } from "./handlers/worktrees.js";

const inspect = vi.mocked(inspectCodebase);
const updateBaseBranch = vi.mocked(updateBaseBranchAfterFetch);
const discover = vi.mocked(discoverWorktrees);
const capture = vi.mocked(captureCommand);

const snapshot = {
  folder: "/repo",
  observedOrigin: "git@github.com:openai/codex.git",
  canonicalOrigin: "github.com/openai/codex",
  displayOrigin: "github.com/openai/codex",
  branch: "main",
  headSha: "abc",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  syncState: "IN_SYNC" as const,
  availability: "AVAILABLE" as const,
  error: null,
  checkedAt: new Date(0).toISOString(),
  fetchedAt: null,
  linkedWorktree: false,
};

describe("CodebaseMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discover.mockResolvedValue({
      complete: true,
      defaultBranch: "main",
      localBranches: ["main"],
      remoteBranches: ["main"],
      worktrees: [],
    });
  });

  test("inspects owned registrations and reports typed snapshots", async () => {
    const client = {
      agentCodebaseConfiguration: vi.fn().mockResolvedValue({
        refreshIntervalSeconds: 120,
        fetchIntervalSeconds: 300,
        codebases: [
          {
            id: "a",
            folder: "/a",
            canonicalOrigin: "example.com/a",
            defaultBranch: "main",
            keepBaseBranchUpToDate: true,
            lastFetchedAt: null,
            lastFetchAttemptAt: new Date().toISOString(),
            worktrees: [],
          },
          {
            id: "b",
            folder: "/b",
            canonicalOrigin: "example.com/b",
            defaultBranch: "main",
            keepBaseBranchUpToDate: true,
            lastFetchedAt: null,
            lastFetchAttemptAt: new Date().toISOString(),
            worktrees: [],
          },
        ],
      }),
      reportCodebaseStatuses: vi.fn().mockResolvedValue({}),
      reportWorktrees: vi.fn().mockResolvedValue({}),
    } as unknown as AgentGraphQLClient;
    inspect.mockImplementation(async (folder) => ({ ...snapshot, folder }));
    const monitor = new CodebaseMonitor(client);

    await monitor.reconcile(new AbortController().signal);

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(monitor.reconcileIntervalMs).toBe(120_000);
    expect(client.reportCodebaseStatuses).toHaveBeenCalledWith([
      { codebaseId: "a", snapshot: { ...snapshot, folder: "/a" } },
      { codebaseId: "b", snapshot: { ...snapshot, folder: "/b" } },
    ]);
  });

  test("does not overlap reconciliation passes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      agentCodebaseConfiguration: vi.fn().mockResolvedValue({
        refreshIntervalSeconds: 30,
        fetchIntervalSeconds: 300,
        codebases: [
          {
            id: "a",
            folder: "/a",
            canonicalOrigin: "example.com/a",
            defaultBranch: "main",
            keepBaseBranchUpToDate: true,
            lastFetchedAt: null,
            lastFetchAttemptAt: new Date().toISOString(),
            worktrees: [],
          },
        ],
      }),
      reportCodebaseStatuses: vi.fn().mockResolvedValue({}),
      reportWorktrees: vi.fn().mockResolvedValue({}),
    } as unknown as AgentGraphQLClient;
    inspect.mockImplementation(async () => {
      await gate;
      return snapshot;
    });
    const monitor = new CodebaseMonitor(client);
    const first = monitor.reconcile(new AbortController().signal);
    await Promise.resolve();
    await monitor.reconcile(new AbortController().signal);
    release();
    await first;

    expect(client.agentCodebaseConfiguration).toHaveBeenCalledTimes(1);
  });

  test("updates the configured base branch after a successful automatic fetch", async () => {
    const client = {
      agentCodebaseConfiguration: vi.fn().mockResolvedValue({
        refreshIntervalSeconds: 30,
        fetchIntervalSeconds: 10,
        codebases: [
          {
            id: "a",
            folder: "/a",
            canonicalOrigin: "example.com/a",
            defaultBranch: "main",
            keepBaseBranchUpToDate: true,
            lastFetchedAt: null,
            lastFetchAttemptAt: null,
            worktrees: [],
          },
        ],
      }),
      reportCodebaseStatuses: vi.fn().mockResolvedValue({}),
      reportWorktrees: vi.fn().mockResolvedValue({}),
    } as unknown as AgentGraphQLClient;
    inspect.mockResolvedValue(snapshot);
    capture.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    });
    updateBaseBranch.mockResolvedValue(true);

    await new CodebaseMonitor(client).reconcile(new AbortController().signal);

    expect(updateBaseBranch).toHaveBeenCalledWith(
      "/a",
      "main",
      30_000,
      expect.any(AbortSignal),
    );
  });

  test("does not update the base branch when the repository setting is off", async () => {
    const client = {
      agentCodebaseConfiguration: vi.fn().mockResolvedValue({
        refreshIntervalSeconds: 30,
        fetchIntervalSeconds: 10,
        codebases: [
          {
            id: "a",
            folder: "/a",
            canonicalOrigin: "example.com/a",
            defaultBranch: "main",
            keepBaseBranchUpToDate: false,
            lastFetchedAt: null,
            lastFetchAttemptAt: null,
            worktrees: [],
          },
        ],
      }),
      reportCodebaseStatuses: vi.fn().mockResolvedValue({}),
      reportWorktrees: vi.fn().mockResolvedValue({}),
    } as unknown as AgentGraphQLClient;
    inspect.mockResolvedValue(snapshot);
    capture.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    });

    await new CodebaseMonitor(client).reconcile(new AbortController().signal);

    expect(updateBaseBranch).not.toHaveBeenCalled();
  });
});
