import { describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { ToolsService } from "./tools.service";
import { externalEndpointHash } from "./mcp-tool-reference";

const input = {
  name: "Reader",
  description: "",
  iconKey: "wrench",
  enabledForPlans: true,
  enabledForSessions: true,
  toolNames: ["get_codebases"],
};

describe("preset persistence safeguards", () => {
  test("rejects a legacy edit of a mixed preset before changing any membership", async () => {
    const transaction = vi.fn();
    getPrismaClient.mockResolvedValue({
      mcpToolPreset: {
        findUnique: vi.fn().mockResolvedValue({
          id: "one",
          externalTools: [{ serverId: "server", toolName: "search" }],
        }),
      },
      $transaction: transaction,
    });
    await expect(
      new ToolsService({} as never).updateMcpToolPreset("one", input),
    ).rejects.toThrow("Upgrade this client");
    expect(transaction).not.toHaveBeenCalled();
  });

  test("rechecks mixed membership inside the transaction after a concurrent external selection", async () => {
    const upsert = vi.fn();
    const transaction = {
      mcpToolPreset: {
        findUnique: vi.fn().mockResolvedValue({ id: "one" }),
        upsert,
      },
      mcpToolPresetExternalTool: { count: vi.fn().mockResolvedValue(1) },
    };
    getPrismaClient.mockResolvedValue({
      mcpToolPreset: {
        findUnique: vi.fn().mockResolvedValue({ id: "one", externalTools: [] }),
      },
      $transaction: vi.fn(async (action) => action(transaction)),
    });
    await expect(
      new ToolsService({} as never).updateMcpToolPreset("one", input),
    ).rejects.toThrow("Upgrade this client");
    expect(upsert).not.toHaveBeenCalled();
  });

  test("rejects stale replacement state and changed server endpoints before writes", async () => {
    const service = new ToolsService({} as never);
    const upsert = vi.fn();
    const transaction = {
      mcpToolPreset: { findMany: vi.fn().mockResolvedValue([]), upsert },
      externalMcpServer: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "server",
            url: "https://changed.example/mcp",
            transport: "STREAMABLE_HTTP",
          },
        ]),
      },
    };
    getPrismaClient.mockResolvedValue({
      $transaction: vi.fn(async (action) => action(transaction)),
    });
    await expect(
      service.importMcpToolPresetBatch(
        [{ targetId: null, input }],
        "stale-state",
        [],
      ),
    ).rejects.toThrow("Presets changed");
    await expect(
      service.importMcpToolPresetBatch(
        [{ targetId: null, input }],
        service.presetStateHash([]),
        [
          {
            serverId: "server",
            endpointHash: externalEndpointHash({
              url: "https://original.example/mcp",
              transport: "STREAMABLE_HTTP",
            }),
          },
        ],
      ),
    ).rejects.toThrow("external server changed");
    expect(upsert).not.toHaveBeenCalled();
  });

  test("lets a failed second write roll back the whole import transaction", async () => {
    const service = new ToolsService({} as never);
    const stored: string[] = [];
    const transaction = {
      mcpToolPreset: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn(async ({ create }) => {
          stored.push(create.name);
          if (stored.length === 2) throw new Error("write failed");
        }),
      },
      mcpToolPresetTool: { deleteMany: vi.fn(), createMany: vi.fn() },
      mcpToolPresetExternalTool: { deleteMany: vi.fn() },
    };
    const transact = vi.fn(async (action) => {
      const previous = [...stored];
      try {
        return await action(transaction);
      } catch (error) {
        stored.splice(0, stored.length, ...previous);
        throw error;
      }
    });
    getPrismaClient.mockResolvedValue({ $transaction: transact });
    await expect(
      service.importMcpToolPresetBatch(
        [
          { targetId: null, input },
          { targetId: null, input: { ...input, name: "Second" } },
        ],
        service.presetStateHash([]),
        [],
      ),
    ).rejects.toThrow("write failed");
    expect(transact).toHaveBeenCalledOnce();
    expect(transaction.mcpToolPreset.upsert).toHaveBeenCalledTimes(2);
    expect(stored).toEqual([]);
  });

  test("restricts referenced server deletion before touching credentials", async () => {
    const removeCredential = vi.fn();
    getPrismaClient.mockResolvedValue({
      mcpToolPresetExternalTool: { count: vi.fn().mockResolvedValue(1) },
    });
    const service = new ToolsService({} as never, undefined, {}, {
      delete: removeCredential,
    } as never);
    await expect(service.deleteExternalServer("server")).rejects.toThrow(
      "Remove this server's tools",
    );
    expect(removeCredential).not.toHaveBeenCalled();
  });

  test("detects duplicates after normalizing legacy names", async () => {
    await expect(
      new ToolsService({} as never).createMcpToolPreset({
        ...input,
        toolNames: ["get_codebases", " get_codebases "],
      }),
    ).rejects.toThrow("duplicates");
  });
});
