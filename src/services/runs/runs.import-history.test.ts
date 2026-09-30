// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));
import { RunsService } from "./runs.service";

function database(origin = "IMPORTED") {
  const attempt = {
    id: "attempt-1",
    runId: "run-1",
    rawMetadataJson: "{}",
    run: {
      id: "run-1",
      origin,
      model: "unknown",
      initialPrompt: "Generated conversation title",
      effort: "high",
      finalOutput: "Previous answer",
    },
  };
  const transaction = {
    runEvent: { deleteMany: vi.fn(), createMany: vi.fn() },
    runToolCall: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
    runModelUsage: {
      deleteMany: vi.fn(),
      create: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({
        _sum: {
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 80,
          reasoningTokens: 4,
          estimatedCost: null,
        },
      }),
    },
    agentRun: { update: vi.fn() },
  };
  const prisma = {
    ...transaction,
    runAttempt: {
      findUnique: vi.fn().mockResolvedValue(attempt),
      update: vi.fn(async ({ data }) => {
        attempt.rawMetadataJson = data.rawMetadataJson;
        return attempt;
      }),
    },
    runProviderSync: { upsert: vi.fn() },
    $transaction: vi.fn(async (callback) =>
      typeof callback === "function"
        ? callback(transaction)
        : Promise.all(callback),
    ),
  };
  mocks.getPrismaClient.mockResolvedValue(prisma);
  return { prisma, transaction, attempt };
}

const record = {
  nativeId: "native-1",
  worktreeId: "worktree-1",
  model: "model-a",
  events: [
    {
      id: "turn:item",
      sequence: 0,
      type: "ITEM_COMPLETED",
      summary: "npm test",
      raw: {
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            command: "npm test",
            status: "completed",
            aggregatedOutput: "passed",
          },
        },
      },
    },
  ],
  usage: [
    {
      model: "model-a",
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 80,
      reasoningTokens: 4,
    },
  ],
};

describe("imported run history", () => {
  beforeEach(() => vi.clearAllMocks());

  test("backfills existing imports and skips identical snapshots", async () => {
    const { transaction } = database();
    const service = new RunsService();
    await service.importRuns("agent-1", "CODEX", [record]);
    expect(transaction.runEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: "attempt-1:import:turn:item",
          sequence: 0,
          rawJson: JSON.stringify(record.events[0]!.raw),
        }),
      ],
    });
    expect(transaction.runModelUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: "model-a",
        inputTokens: 20,
        cacheReadTokens: 80,
        estimatedCost: null,
      }),
    });
    expect(transaction.runToolCall.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          name: "npm test",
          status: "COMPLETED",
          outputJson: '"passed"',
        }),
      ],
    });
    await service.importRuns("agent-1", "CODEX", [record]);
    expect(transaction.runEvent.createMany).toHaveBeenCalledTimes(1);
    expect(transaction.runModelUsage.create).toHaveBeenCalledTimes(1);
    await service.importRuns("agent-1", "CODEX", [
      { ...record, events: [], usage: [] },
    ]);
    expect(transaction.runEvent.deleteMany).toHaveBeenCalledTimes(2);
    expect(transaction.runModelUsage.deleteMany).toHaveBeenCalledTimes(2);
  });

  test("backfills the displayed prompt and initial input even when the history is unchanged", async () => {
    const { transaction, prisma } = database();
    const service = new RunsService();
    await service.importRuns("agent-1", "OPENCODE", [record]);
    await service.importRuns("agent-1", "OPENCODE", [
      {
        ...record,
        prompt: "  Original user prompt.\n\nInclude all details.  ",
      },
    ]);
    expect(prisma.agentRun.update).toHaveBeenLastCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        initialPrompt: "Original user prompt.\n\nInclude all details.",
        inputs: {
          updateMany: {
            where: { kind: "INITIAL", sequence: 0 },
            data: { prompt: "Original user prompt.\n\nInclude all details." },
          },
        },
      }),
    });
    expect(transaction.runEvent.createMany).toHaveBeenCalledTimes(1);
    expect(transaction.runModelUsage.create).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, null, " \n "])(
    "preserves the previous prompt when the imported prompt is missing or blank (%s)",
    async (prompt) => {
      const { prisma } = database();
      await new RunsService().importRuns("agent-1", "OPENCODE", [
        { nativeId: "native-1", worktreeId: "worktree-1", prompt },
      ]);
      const data = prisma.agentRun.update.mock.calls[0]![0].data;
      expect(data).not.toHaveProperty("initialPrompt");
      expect(data).not.toHaveProperty("inputs");
    },
  );

  test("imports a new session and retains histories longer than one event batch", async () => {
    const { prisma, transaction } = database();
    prisma.runAttempt.findUnique.mockResolvedValue(null as never);
    const create = vi.fn().mockResolvedValue({});
    Object.assign(prisma.agentRun, { create });
    Object.assign(transaction, {
      runNumberSequence: {
        upsert: vi.fn().mockResolvedValue({ nextValue: 1 }),
      },
    });
    Object.assign(prisma, {
      worktree: {
        findUnique: vi.fn().mockResolvedValue({
          id: "worktree-1",
          branch: "main",
          codebase: {
            agentId: "agent-1",
            repository: { id: "repo-1", name: "Example" },
          },
        }),
      },
    });
    const events = Array.from({ length: 501 }, (_, sequence) => ({
      id: `item-${sequence}`,
      sequence,
      type: "ITEM_COMPLETED",
      summary: `Message ${sequence}`,
    }));
    await expect(
      new RunsService().importRuns("agent-1", "CODEX", [
        { ...record, events, prompt: "Original prompt" },
      ]),
    ).resolves.toBe(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          model: "model-a",
          origin: "IMPORTED",
          initialPrompt: "Original prompt",
          inputs: {
            create: expect.objectContaining({
              kind: "INITIAL",
              sequence: 0,
              prompt: "Original prompt",
            }),
          },
        }),
      }),
    );
    expect(
      transaction.runEvent.createMany.mock.calls.map(
        ([batch]) => batch.data.length,
      ),
    ).toEqual([500, 1]);
    expect(transaction.runModelUsage.create).toHaveBeenCalledOnce();
  });

  test("does not replace activity or usage when enrichment is unavailable", async () => {
    const { transaction, prisma } = database();
    await new RunsService().importRuns("agent-1", "CODEX", [
      { nativeId: "native-1", worktreeId: "worktree-1" },
    ]);
    expect(transaction.runEvent.deleteMany).not.toHaveBeenCalled();
    expect(transaction.runModelUsage.deleteMany).not.toHaveBeenCalled();
    expect(prisma.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          effort: "high",
          finalOutput: "Previous answer",
        }),
      }),
    );
  });

  test("leaves managed run history untouched", async () => {
    const { transaction, prisma } = database("MANAGED");
    await new RunsService().importRuns("agent-1", "OPENCODE", [
      { ...record, prompt: "Imported prompt" },
    ]);
    expect(transaction.runEvent.deleteMany).not.toHaveBeenCalled();
    expect(prisma.agentRun.update).not.toHaveBeenCalled();
  });

  test("does not record success before history persistence succeeds", async () => {
    const { transaction, attempt } = database();
    transaction.runEvent.createMany.mockRejectedValueOnce(
      new Error("database failed"),
    );
    const service = new RunsService();
    await expect(
      service.importRuns("agent-1", "CODEX", [record]),
    ).rejects.toThrow("database failed");
    expect(
      JSON.parse(attempt.rawMetadataJson).importedHistoryDigest,
    ).toBeUndefined();
    await service.importRuns("agent-1", "CODEX", [record]);
    expect(transaction.runEvent.createMany).toHaveBeenCalledTimes(2);
  });

  test("persists OpenCode tool input, output, errors, timing and reported session cost", async () => {
    const { transaction } = database();
    const input = {
      ...record,
      estimatedCost: 0.25,
      pricingSource: "opencode-history",
      usage: [
        {
          ...record.usage[0]!,
          estimatedCost: 0.2,
          pricingSource: "opencode-history",
        },
      ],
      events: [
        {
          id: "message:tool",
          sequence: 0,
          type: "MESSAGE_PART_UPDATED",
          summary: "websearch",
          raw: {
            type: "message.part.updated",
            properties: {
              part: {
                type: "tool",
                tool: "websearch",
                state: {
                  status: "error",
                  input: { query: "OpenCode import" },
                  output: "Partial results",
                  error: "Search unavailable",
                  time: { start: 1_000, end: 2_000 },
                },
              },
            },
          },
        },
      ],
    };
    const service = new RunsService();
    await service.importRuns("agent-1", "OPENCODE", [input]);
    expect(transaction.runToolCall.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          name: "websearch",
          status: "FAILED",
          inputJson: JSON.stringify(input.events[0]!.raw),
          outputJson: '"Partial results"',
          error: "Search unavailable",
          startedAt: new Date(1_000),
          finishedAt: new Date(2_000),
        }),
      ],
    });
    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        estimatedCost: 0.25,
        pricingSource: "opencode-history",
      }),
    });
    await service.importRuns("agent-1", "OPENCODE", [
      { ...input, estimatedCost: 0 },
    ]);
    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        estimatedCost: 0,
        pricingSource: "opencode-history",
      }),
    });
    expect(transaction.runEvent.createMany).toHaveBeenCalledTimes(2);
  });

  test("pairs Claude tool calls with their results and persists recorded cost", async () => {
    const { transaction } = database();
    transaction.runToolCall.count.mockResolvedValue(3);
    const toolEvents = [
      { id: "search", name: "WebSearch", input: { query: "Claude docs" } },
      { id: "bash", name: "Bash", input: { command: "npm test" } },
      { id: "read", name: "Read", input: { file_path: "app.ts" } },
    ].map((tool, sequence) => ({
      id: `assistant:${tool.id}`,
      sequence,
      type: "ASSISTANT",
      summary: tool.name,
      createdAt: "2026-09-30T12:00:00Z",
      raw: {
        type: "assistant",
        message: { content: [{ type: "tool_use", ...tool }] },
      },
    }));
    const results = [
      { tool_use_id: "search", content: "Search results", is_error: false },
      { tool_use_id: "bash", content: "Tests failed", is_error: true },
    ].map((result, sequence) => ({
      id: `user:${result.tool_use_id}`,
      sequence: toolEvents.length + sequence,
      type: "USER",
      summary: result.content,
      createdAt: "2026-09-30T12:00:02Z",
      raw: {
        type: "user",
        message: { content: [{ type: "tool_result", ...result }] },
      },
    }));
    await new RunsService().importRuns("agent-1", "CLAUDE", [
      {
        ...record,
        events: [...toolEvents, ...results],
        estimatedCost: 0.75,
        pricingSource: "claude-transcript",
        usage: [{ ...record.usage[0]!, estimatedCost: 0.75 }],
      },
    ]);
    expect(transaction.runToolCall.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          name: "WebSearch",
          status: "COMPLETED",
          inputJson: JSON.stringify(toolEvents[0]!.raw),
          outputJson: '"Search results"',
          error: null,
          startedAt: new Date("2026-09-30T12:00:00Z"),
          finishedAt: new Date("2026-09-30T12:00:02Z"),
        }),
        expect.objectContaining({
          name: "Bash",
          status: "FAILED",
          outputJson: '"Tests failed"',
          error: "Tests failed",
        }),
        expect.objectContaining({
          name: "Read",
          status: "OBSERVED",
          outputJson: "null",
          error: null,
          finishedAt: null,
        }),
      ],
    });
    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { toolCallCount: 3 },
    });
    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        estimatedCost: 0.75,
        pricingSource: "claude-transcript",
      }),
    });
  });

  test("sums complete model costs but keeps incomplete estimates unknown", async () => {
    const { transaction } = database();
    transaction.runModelUsage.aggregate.mockResolvedValue({
      _sum: {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 80,
        reasoningTokens: 4,
        estimatedCost: 0.3,
      },
    } as never);
    const service = new RunsService();
    await service.importRuns("agent-1", "OPENCODE", [
      {
        ...record,
        usage: [
          {
            ...record.usage[0]!,
            estimatedCost: 0.3,
            pricingSource: "opencode-history",
          },
        ],
      },
    ]);
    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        estimatedCost: 0.3,
        pricingSource: "opencode-history",
      }),
    });
    await service.importRuns("agent-1", "OPENCODE", [
      {
        ...record,
        usage: [
          { ...record.usage[0]!, model: "unpriced-model" },
          { ...record.usage[0]!, estimatedCost: 0.3 },
        ],
      },
    ]);
    expect(transaction.agentRun.update).toHaveBeenLastCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({ estimatedCost: null }),
    });
  });

  test("can update reported costs without replacing unavailable histories", async () => {
    const { transaction } = database();
    await new RunsService().importRuns("agent-1", "OPENCODE", [
      {
        nativeId: "native-1",
        worktreeId: "worktree-1",
        estimatedCost: 0.1,
        pricingSource: "opencode-history",
      },
    ]);
    expect(transaction.runEvent.deleteMany).not.toHaveBeenCalled();
    expect(transaction.runModelUsage.deleteMany).not.toHaveBeenCalled();
    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({ estimatedCost: 0.1 }),
    });
  });
});
