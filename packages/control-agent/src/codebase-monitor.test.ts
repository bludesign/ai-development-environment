import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./handlers/codebases.js", () => ({
  inspectCodebase: vi.fn(),
  updateBaseBranchAfterFetch: vi.fn(),
}));
vi.mock("./handlers/worktrees.js", () => ({ discoverWorktrees: vi.fn() }));
vi.mock("./capture-command.js", () => ({ captureCommand: vi.fn() }));
vi.mock("./repository-metadata.js", () => ({
  withRepositoryMetadata: vi.fn(async (_folder, task) => task()),
}));
vi.mock("./handlers/local-branches.js", () => ({
  scanLocalBranches: vi
    .fn()
    .mockResolvedValue({ scannedAt: "2026-10-01T00:00:00.000Z", branches: [] }),
}));

import { captureCommand } from "./capture-command.js";
import { CodebaseMonitor } from "./codebase-monitor.js";
import type { AgentGraphQLClient } from "./graphql-client.js";
import {
  inspectCodebase,
  updateBaseBranchAfterFetch,
} from "./handlers/codebases.js";
import { discoverWorktrees } from "./handlers/worktrees.js";
import { RepositoryCoordinator } from "./repository-coordinator.js";

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

  test("fetches during a source build and defers only that base checkout update", async () => {
    const registration = {
      id: "repo",
      folder: "/a",
      canonicalOrigin: "example.com/a",
      defaultBranch: "main",
      keepBaseBranchUpToDate: true,
      lastFetchedAt: null,
      lastFetchAttemptAt: null,
      worktrees: [
        {
          id: "main",
          folder: "/a",
          gitDirectory: "/a/.git",
          branch: "main",
          baseBranchOverride: null,
        },
      ],
    };
    const client = {
      agentCodebaseConfiguration: vi.fn().mockResolvedValue({
        refreshIntervalSeconds: 30,
        fetchIntervalSeconds: 10,
        codebases: [registration],
      }),
      reportCodebaseStatuses: vi.fn().mockResolvedValue({}),
      reportWorktrees: vi.fn().mockResolvedValue({}),
    };
    inspect.mockResolvedValue(snapshot);
    capture.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
    });
    const coordinator = new RepositoryCoordinator();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const build = coordinator.withResources(
      [
        {
          kind: "WORKTREE",
          key: "agent:worktree:/a/.git",
          agentId: "agent",
          codebaseId: "repo",
          mode: "BUILD",
        },
      ],
      async () => {
        started.resolve();
        await finish.promise;
      },
    );
    await started.promise;
    const monitor = new CodebaseMonitor(
      client as unknown as AgentGraphQLClient,
      coordinator,
      "agent",
    );
    try {
      await monitor.reconcile(new AbortController().signal);
      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({ args: ["-C", "/a", "fetch", "origin"] }),
      );
      expect(updateBaseBranch).not.toHaveBeenCalled();
      expect(client.reportWorktrees).toHaveBeenCalledWith([
        expect.objectContaining({ observedAt: expect.any(String) }),
      ]);
    } finally {
      finish.resolve();
      await build;
    }
    await monitor.reconcile(new AbortController().signal);
    expect(updateBaseBranch).toHaveBeenCalledOnce();
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
      expect.objectContaining({
        codebaseId: "a",
        snapshot: { ...snapshot, folder: "/a" },
      }),
    ]);
    expect(client.reportCodebaseStatuses).toHaveBeenCalledWith([
      expect.objectContaining({
        codebaseId: "b",
        snapshot: { ...snapshot, folder: "/b" },
      }),
    ]);
  });

  test("persists inventory before a following fetch even when another checkout is slow", async () => {
    const firstDiscovered = Promise.withResolvers<void>();
    const slowScan = Promise.withResolvers<void>();
    const reportStarted = Promise.withResolvers<"report">();
    const reportCompleted = Promise.withResolvers<void>();
    const fetchStarted = Promise.withResolvers<"fetch">();
    let branches: string[] = [];
    const client = {
      agentCodebaseConfiguration: vi.fn().mockResolvedValue({
        refreshIntervalSeconds: 30,
        fetchIntervalSeconds: 300,
        codebases: ["a", "b"].map((id) => ({
          id,
          folder: `/${id}`,
          canonicalOrigin: `example.com/${id}`,
          defaultBranch: "main",
          keepBaseBranchUpToDate: false,
          lastFetchedAt: null,
          lastFetchAttemptAt: new Date().toISOString(),
          worktrees: [],
        })),
      }),
      reportCodebaseStatuses: vi.fn().mockResolvedValue({}),
      reportWorktrees: vi.fn<AgentGraphQLClient["reportWorktrees"]>(
        async (reports) => {
          if (reports.some((report) => report.codebaseId === "a")) {
            reportStarted.resolve("report");
            await reportCompleted.promise;
            branches = reports.find(
              (report) => report.codebaseId === "a",
            )!.remoteBranches;
          }
          return { reportWorktrees: [] };
        },
      ),
    } as unknown as AgentGraphQLClient;
    inspect.mockImplementation(async (folder) => ({ ...snapshot, folder }));
    discover.mockImplementation(async (folder) => {
      if (folder === "/b") await slowScan.promise;
      else firstDiscovered.resolve();
      return {
        complete: true,
        defaultBranch: "main",
        localBranches: ["main"],
        remoteBranches: ["main"],
        worktrees: [],
      };
    });
    const coordinator = new RepositoryCoordinator();
    const monitor = new CodebaseMonitor(client, coordinator);
    const reconciliation = monitor.reconcile(new AbortController().signal);
    await firstDiscovered.promise;
    const fetch = coordinator.run("a", async () => {
      fetchStarted.resolve("fetch");
      branches = ["main", "new-remote-branch"];
    });

    const first = await Promise.race([
      reportStarted.promise,
      fetchStarted.promise,
    ]);
    reportCompleted.resolve();
    await fetch;
    slowScan.resolve();
    await reconciliation;

    expect(first).toBe("report");
    expect(branches).toEqual(["main", "new-remote-branch"]);
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

  test("keeps commits and changes inspectable while an automatic fetch is slow", async () => {
    const fetchStarted = Promise.withResolvers<void>();
    const finishFetch = Promise.withResolvers<void>();
    const coordinator = new RepositoryCoordinator();
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
    capture.mockImplementation(async () => {
      fetchStarted.resolve();
      await finishFetch.promise;
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
      };
    });
    const monitor = new CodebaseMonitor(client, coordinator);
    const reconciliation = monitor.reconcile(new AbortController().signal);
    await fetchStarted.promise;
    const loadDetail = vi.fn(async () => ({ commits: [], changes: [] }));
    const inspection = coordinator.runInspection("a", loadDetail);
    try {
      await vi.waitFor(() => expect(loadDetail).toHaveBeenCalledOnce());
      await expect(inspection).resolves.toEqual({ commits: [], changes: [] });
      expect(client.reportWorktrees).not.toHaveBeenCalled();
    } finally {
      finishFetch.resolve();
      await reconciliation;
    }
    expect(updateBaseBranch).toHaveBeenCalled();
    expect(client.reportWorktrees).toHaveBeenCalledOnce();
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
      outputTruncated: false,
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

  test("keeps read inspections available during the post-fetch snapshot when base updates are off", async () => {
    const snapshotStarted = Promise.withResolvers<void>();
    const finishSnapshot = Promise.withResolvers<void>();
    const coordinator = new RepositoryCoordinator();
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
    inspect.mockResolvedValueOnce(snapshot).mockImplementationOnce(async () => {
      snapshotStarted.resolve();
      await finishSnapshot.promise;
      return snapshot;
    });
    capture.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
    });

    const reconciliation = new CodebaseMonitor(client, coordinator).reconcile(
      new AbortController().signal,
    );
    await snapshotStarted.promise;
    const loadDetail = vi.fn(async () => ({ commits: [], changes: [] }));
    const inspection = coordinator.runInspection("a", loadDetail);
    try {
      await vi.waitFor(() => expect(loadDetail).toHaveBeenCalledOnce());
      await expect(inspection).resolves.toEqual({ commits: [], changes: [] });
      expect(client.reportWorktrees).not.toHaveBeenCalled();
    } finally {
      finishSnapshot.resolve();
      await Promise.all([inspection, reconciliation]);
    }

    expect(updateBaseBranch).not.toHaveBeenCalled();
    expect(client.reportWorktrees).toHaveBeenCalledOnce();
  });
});
