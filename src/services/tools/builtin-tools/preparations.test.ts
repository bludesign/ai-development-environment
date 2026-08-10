import { describe, expect, test, vi } from "vitest";

import type {
  CodebasesService,
  CodebaseToolsService,
} from "@/services/codebases";
import type {
  WorktreeAutomationService,
  WorktreesService,
} from "@/services/worktrees";

import { createCodebaseToolGroup } from "./codebases";
import { createWorktreeAutomationToolGroup } from "./worktree-automations";
import { createWorktreeToolGroup } from "./worktrees";

function tool(group: ReturnType<typeof createWorktreeToolGroup>, name: string) {
  const definition = group.tools.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing tool ${name}`);
  return definition;
}

describe("repository preparation MCP tools", () => {
  test("lists and atomically saves repository preparation definitions", async () => {
    const preparation = {
      id: "preparation-1",
      repositoryId: "repository-1",
      kind: "WRITE",
      path: ".env.test",
      contents: Uint8Array.from([65, 73, 68, 69]),
      contentSha256: "sha256",
      byteCount: 4,
      definitionHash: "definition",
      createdAt: new Date("2026-08-09T12:00:00.000Z"),
      updatedAt: new Date("2026-08-09T12:01:00.000Z"),
    };
    const repositoryPreparations = vi.fn().mockResolvedValue([preparation]);
    const saveRepositoryPreparations = vi.fn().mockResolvedValue({});
    const group = createCodebaseToolGroup(
      {} as CodebaseToolsService,
      {
        repositoryPreparations,
        saveRepositoryPreparations,
      } as unknown as CodebasesService,
    );
    const get = group.tools.find(
      ({ name }) => name === "get_codebase_repository_preparations",
    )!;
    const save = group.tools.find(
      ({ name }) => name === "save_codebase_repository_preparations",
    )!;

    await expect(
      get.invoke({ repositoryId: "repository-1" }),
    ).resolves.toMatchObject({
      preparations: [
        {
          path: ".env.test",
          contentBase64: "QUlERQ==",
          byteCount: 4,
        },
      ],
    });
    await save.invoke({
      repositoryId: "repository-1",
      preparations: [
        {
          id: "preparation-1",
          kind: "WRITE",
          path: ".env.test",
        },
      ],
    });

    expect(saveRepositoryPreparations).toHaveBeenCalledWith("repository-1", [
      {
        id: "preparation-1",
        kind: "WRITE",
        path: ".env.test",
      },
    ]);
    expect(save.annotations.destructiveHint).toBe(true);
  });
});

describe("worktree preparation MCP tools", () => {
  test("returns a compact overview without uploaded preparation bytes", async () => {
    const preparation = {
      id: "preparation-1",
      kind: "WRITE",
      path: ".env.test",
      contents: Uint8Array.from([1, 2, 3]),
      contentSha256: "sha256",
      byteCount: 3,
      definitionHash: "definition",
    };
    const preparationOverview = vi.fn().mockResolvedValue({
      repositories: [
        {
          repository: {
            id: "repository-1",
            name: "AIDE",
            canonicalOrigin: "github.com/example/aide",
            displayOrigin: "github.com/example/aide",
            preparations: [preparation],
          },
          worktrees: [
            {
              worktree: {
                id: "worktree-1",
                codebaseId: "codebase-1",
                folder: "/work/aide",
                relativePath: "aide",
                branch: "main",
                baseBranch: "main",
                primary: true,
                availability: "AVAILABLE",
                missingAt: null,
              },
              agent: {
                id: "agent-1",
                name: "Studio",
                hostname: "studio.local",
                version: "1.0.0",
              },
              supported: true,
              unsupportedReason: null,
              overallState: "APPLIED",
              statuses: [
                {
                  preparation,
                  state: "APPLIED",
                  message: null,
                  checkedAt: new Date("2026-08-09T12:00:00.000Z"),
                },
              ],
              activeJob: null,
            },
          ],
        },
      ],
    });
    const group = createWorktreeToolGroup({
      preparationOverview,
    } as unknown as WorktreesService);

    const result = await tool(
      group,
      "get_worktree_preparation_overview",
    ).invoke({});

    expect(result).toMatchObject({
      overview: {
        repositories: [
          {
            preparations: [
              {
                id: "preparation-1",
                path: ".env.test",
                byteCount: 3,
              },
            ],
            worktrees: [
              {
                overallState: "APPLIED",
                statuses: [
                  {
                    preparationId: "preparation-1",
                    checkedAt: "2026-08-09T12:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("contents");
  });

  test("dispatches preparation actions and forwards forced worktree sync", async () => {
    const runPreparations = vi.fn().mockResolvedValue({
      jobs: [{ id: "prepare-job" }],
      skipped: [],
    });
    const runOperation = vi.fn().mockResolvedValue({ id: "sync-job" });
    const group = createWorktreeToolGroup({
      runPreparations,
      runOperation,
    } as unknown as WorktreesService);

    await tool(group, "run_worktree_preparations").invoke({
      worktreeIds: ["worktree-1"],
      action: "APPLY",
      requestId: "request-1",
    });
    await tool(group, "run_worktree_operation").invoke({
      worktreeId: "worktree-1",
      operation: "SYNC",
      requestId: "request-2",
      forcePreparations: true,
    });

    expect(runPreparations).toHaveBeenCalledWith(
      ["worktree-1"],
      "APPLY",
      "request-1",
    );
    expect(runOperation).toHaveBeenCalledWith(
      "worktree-1",
      "SYNC",
      "request-2",
      true,
    );
    expect(
      tool(group, "run_worktree_preparations").annotations.destructiveHint,
    ).toBe(true);
  });

  test("exposes preparation pause reasons and force Auto Sync", async () => {
    const forceAutoSync = vi.fn().mockResolvedValue({ id: "force-job" });
    const autoSync = vi.fn().mockResolvedValue({
      worktreeId: "worktree-1",
      state: "PAUSED",
      conflictWorkflowId: null,
      conflictWorkflowChoice: null,
      lastError: "Preparations block the rebase",
      pauseReason: "PREPARATION_CONFLICT",
      lastSyncedAt: null,
      updatedAt: "2026-08-09T12:00:00.000Z",
    });
    const autoMerge = vi.fn().mockResolvedValue(null);
    const group = createWorktreeAutomationToolGroup(
      () =>
        ({
          autoSync,
          autoMerge,
          forceAutoSync,
        }) as unknown as WorktreeAutomationService,
    );
    const get = group.tools.find(
      ({ name }) => name === "get_worktree_automations",
    )!;
    const force = group.tools.find(
      ({ name }) => name === "force_worktree_auto_sync",
    )!;

    await expect(
      get.invoke({ worktreeId: "worktree-1" }),
    ).resolves.toMatchObject({
      autoSync: { pauseReason: "PREPARATION_CONFLICT" },
    });
    await force.invoke({
      worktreeId: "worktree-1",
      requestId: "request-3",
    });

    expect(forceAutoSync).toHaveBeenCalledWith("worktree-1", "request-3");
    expect(force.annotations.destructiveHint).toBe(true);
  });
});
