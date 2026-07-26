import { describe, expect, test, vi } from "vitest";

import type { BuiltInToolGroup } from "../builtin-tools";
import { createRunToolGroup } from "./runs";
import { createSigningAssetToolGroup } from "./signing-assets";
import { createUsageCostToolGroup } from "./usage-costs";

function findTool(group: BuiltInToolGroup, name: string) {
  return group.tools.find((candidate) => candidate.name === name)!;
}

describe("operational tool contracts", () => {
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
