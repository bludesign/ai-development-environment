import { describe, expect, test, vi } from "vitest";

import { WorkflowEventBridge } from "./workflow-event-bridge";

function worktree(baseBehind: number | null) {
  return {
    id: "worktree-1",
    folder: "/tmp/worktree-1",
    branch: "feature/test",
    headSha: null,
    pushStatus: "READY",
    baseBehind,
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    lastCheckedAt: new Date("2026-07-24T12:00:00.000Z"),
    missingAt: null,
    updatedAt: new Date("2026-07-24T12:00:00.000Z"),
    codebase: {
      id: "codebase-1",
      folder: "/tmp/codebase-1",
      agentId: "agent-1",
      defaultBranch: "main",
      repository: {
        id: "repository-1",
        canonicalOrigin: "github.com/acme/widgets",
        displayOrigin: "github.com/acme/widgets",
      },
    },
  };
}

describe("workflow worktree event bridge", () => {
  test("records behind events only when the worktree is behind", async () => {
    const record = vi.fn().mockResolvedValue({});
    const bridge = new WorkflowEventBridge(
      { record } as never,
      {} as never,
    ) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

    await bridge.observeWorktree(worktree(0));
    expect(record.mock.calls.map(([input]) => input.kind)).not.toContain(
      "WORKTREE_BEHIND",
    );

    record.mockClear();
    await bridge.observeWorktree(worktree(2));
    expect(record.mock.calls.map(([input]) => input.kind)).toContain(
      "WORKTREE_BEHIND",
    );
  });
});
