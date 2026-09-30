import { describe, expect, test, vi } from "vitest";

import type { BuiltInToolGroup } from "../builtin-tools";
import { createRunToolGroup } from "./runs";
import { createSigningAssetToolGroup } from "./signing-assets";
import { createUsageCostToolGroup } from "./usage-costs";
import { createToolAdministrationGroup } from "./tool-administration";
import { createSseToolGroup } from "./sse";

function findTool(group: BuiltInToolGroup, name: string) {
  return group.tools.find((candidate) => candidate.name === name)!;
}

describe("operational tool contracts", () => {
  test("discovers local preset IDs and forwards selections to every run creation path", async () => {
    const presets = [
      {
        id: "preset-1",
        name: "Investigate",
        description: "Investigation tools",
        iconKey: "wrench",
        enabledForPlans: true,
        enabledForSessions: true,
        toolNames: [],
        createdAt: "2026-09-29T00:00:00.000Z",
        updatedAt: "2026-09-29T00:00:00.000Z",
        tools: [{ source: "EXTERNAL", serverId: "server-1", name: "search" }],
      },
    ];
    const listMcpToolPresets = vi.fn().mockResolvedValue(presets);
    const administration = createToolAdministrationGroup(
      {} as never,
      vi.fn(),
      listMcpToolPresets,
    );
    await expect(
      findTool(administration, "get_mcp_tool_presets").invoke({
        kind: "SESSION",
      }),
    ).resolves.toEqual({ presets });
    expect(listMcpToolPresets).toHaveBeenCalledWith("SESSION");
    await findTool(administration, "get_mcp_tool_presets").invoke({});
    expect(listMcpToolPresets).toHaveBeenLastCalledWith(undefined);

    const create = vi.fn().mockResolvedValue({ id: "run-1" });
    const followUp = vi.fn().mockResolvedValue({ id: "run-2" });
    const playPlan = vi.fn().mockResolvedValue({ id: "run-3" });
    const group = createRunToolGroup({ create, followUp, playPlan } as never);
    const input = {
      kind: "SESSION",
      worktreeId: "worktree-1",
      provider: "CODEX",
      model: "model",
      prompt: "Investigate",
      mcpPresetIds: ["preset-1"],
    };
    await findTool(group, "create_agent_run").invoke(input);
    await findTool(group, "create_run_follow_up").invoke({
      sourceId: "run-1",
      input,
    });
    await findTool(group, "play_plan").invoke({
      planId: "plan-1",
      mcpPresetIds: ["preset-1"],
    });
    expect(create).toHaveBeenCalledWith(input);
    expect(followUp).toHaveBeenCalledWith("run-1", input);
    expect(playPlan).toHaveBeenCalledWith("plan-1", ["preset-1"]);
    await findTool(group, "play_plan").invoke({ planId: "plan-2" });
    expect(playPlan).toHaveBeenLastCalledWith("plan-2", []);
  });

  test("queues revision preparation and advertises rollback and non-idempotent effects", async () => {
    const run = {
      id: "run-1",
      kind: "SESSION",
      status: "COMPLETED",
      phase: "IDLE",
      worktreeId: "worktree-1",
    };
    const prepareAnswerRevision = vi.fn().mockResolvedValue({
      ...run,
      nativeTranscript: "private transcript",
      mcpToolSnapshotJson: "internal snapshot",
    });
    const reviseAnswer = vi.fn().mockResolvedValue({ id: "run-2" });
    const group = createRunToolGroup({
      prepareAnswerRevision,
      reviseAnswer,
    } as never);
    await expect(
      findTool(group, "prepare_run_answer_revision").invoke({
        batchId: "batch-1",
      }),
    ).resolves.toEqual({ run });
    expect(prepareAnswerRevision).toHaveBeenCalledWith("batch-1");
    await findTool(group, "revise_run_answer").invoke({
      batchId: "batch-1",
      answers: [],
    });
    expect(reviseAnswer).toHaveBeenCalledWith("batch-1", [], false, true);
    expect(
      findTool(group, "prepare_run_answer_revision").annotations,
    ).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(findTool(group, "revise_run_answer").annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
    });
    const sse = createSseToolGroup({} as never);
    for (const name of ["sse_endpoint_create", "sse_storage_increment"]) {
      expect(findTool(sse, name).annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
      });
    }
  });

  test("maps agent-run list filters to the service's required input", async () => {
    const list = vi.fn().mockResolvedValue({ items: [] });
    const group = createRunToolGroup({ list } as never);

    await findTool(group, "get_agent_runs").invoke({});

    expect(list).toHaveBeenCalledWith({
      kind: "SESSION",
      archive: "ACTIVE",
      first: 100,
    });
  });

  test("maps model-cost pagination and cache-token names", async () => {
    const listEntries = vi.fn().mockResolvedValue({ items: [] });
    const estimate = vi.fn().mockReturnValue(1.25);
    const modelCosts = {
      listEntries,
      ensureFresh: vi.fn(),
      lookup: vi.fn().mockResolvedValue(new Map([["gpt", { model: "gpt" }]])),
      estimate,
    };
    const group = createUsageCostToolGroup({} as never, modelCosts as never);

    await findTool(group, "get_model_cost_entries").invoke({ offset: 25 });
    const result = await findTool(group, "estimate_model_cost").invoke({
      model: "gpt",
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
    });

    expect(listEntries).toHaveBeenCalledWith({
      first: 100,
      offset: 25,
      sortKey: "MODEL",
      direction: "ASC",
    });
    expect(estimate).toHaveBeenCalledWith(
      { model: "gpt" },
      {
        inputTokens: 10,
        outputTokens: 20,
        cacheWriteTokens: 30,
        cacheReadTokens: 40,
      },
    );
    expect(result).toEqual({ estimate: 1.25 });
  });

  test("never returns downloaded provisioning-profile contents", async () => {
    const downloadProfile = vi.fn().mockResolvedValue({
      uuid: "profile-1",
      filename: "profile-1.mobileprovision",
      contentBase64: "sensitive-profile-content",
    });
    const group = createSigningAssetToolGroup({ downloadProfile } as never);

    const result = await findTool(group, "download_signing_profile").invoke({
      uuid: "profile-1",
      agentId: "agent-1",
    });

    expect(result).toEqual({
      operation: {
        uuid: "profile-1",
        filename: "profile-1.mobileprovision",
      },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-profile-content");
  });
});
