import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./handlers/codebases.js", () => ({ inspectCodebase: vi.fn() }));

import { inspectCodebase } from "./handlers/codebases.js";
import { CodebaseMonitor } from "./codebase-monitor.js";
import type { AgentGraphQLClient } from "./graphql-client.js";

const inspect = vi.mocked(inspectCodebase);

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
  beforeEach(() => vi.clearAllMocks());

  test("inspects owned registrations and reports typed snapshots", async () => {
    const client = {
      agentCodebases: vi.fn().mockResolvedValue([
        { id: "a", folder: "/a", canonicalOrigin: "example.com/a" },
        { id: "b", folder: "/b", canonicalOrigin: "example.com/b" },
      ]),
      reportCodebaseStatuses: vi.fn().mockResolvedValue({}),
    } as unknown as AgentGraphQLClient;
    inspect.mockImplementation(async (folder) => ({ ...snapshot, folder }));

    await new CodebaseMonitor(client).reconcile(new AbortController().signal);

    expect(inspect).toHaveBeenCalledTimes(2);
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
      agentCodebases: vi
        .fn()
        .mockResolvedValue([
          { id: "a", folder: "/a", canonicalOrigin: "example.com/a" },
        ]),
      reportCodebaseStatuses: vi.fn().mockResolvedValue({}),
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

    expect(client.agentCodebases).toHaveBeenCalledTimes(1);
  });
});
