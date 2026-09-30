import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  claudeImportedHistory,
  claudeTranscriptMetadata,
  readClaudeTranscript,
} from "./claude-import.js";

const usage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 40,
  output_tokens_details: { thinking_tokens: 5 },
};
function assistant(
  uuid: string,
  id: string,
  content: unknown[],
  model = "claude-sonnet-5",
) {
  return {
    type: "assistant",
    uuid,
    timestamp: "2026-09-30T12:00:00Z",
    effort: "high",
    message: { id, model, content, usage },
  };
}

describe("Claude imported history", () => {
  test("retains every tool block, original prompts and final assistant text", () => {
    const user = {
      type: "user",
      uuid: "user-1",
      permissionMode: "plan",
      message: { content: "Full original prompt" },
    };
    const records = [
      user,
      assistant("thinking-1", "message-1", [
        { type: "thinking", thinking: "Reasoning" },
      ]),
      assistant("tools-1", "message-1", [
        {
          type: "tool_use",
          id: "tool-1",
          name: "WebSearch",
          input: { query: "Claude API docs" },
        },
        {
          type: "tool_use",
          id: "tool-2",
          name: "Bash",
          input: { command: "npm test" },
        },
      ]),
      {
        type: "user",
        uuid: "result-1",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Search results",
            },
          ],
        },
      },
      assistant("reply-1", "message-2", [
        { type: "text", text: "The fix is ready." },
      ]),
      assistant("reply-2", "message-2", [
        { type: "text", text: "Tests pass." },
      ]),
    ];
    const imported = claudeImportedHistory(
      records.map((record) => ({ ...record, permissionMode: undefined })),
      records,
    );
    expect(imported).toMatchObject({
      model: "claude-sonnet-5",
      effort: "high",
      prompt: "Full original prompt",
      finalOutput: "The fix is ready.\n\nTests pass.",
      kind: "PLAN",
    });
    expect(imported.events).toHaveLength(7);
    const toolEvents = imported.events!.filter(
      (event) => event.summary === "WebSearch" || event.summary === "Bash",
    );
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]!.raw).toMatchObject({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            input: { query: "Claude API docs" },
          },
        ],
      },
    });
    expect(imported.usage).toEqual([
      {
        model: "claude-sonnet-5",
        inputTokens: 20,
        outputTokens: 40,
        reasoningTokens: 10,
        cacheReadTokens: 60,
        cacheWriteTokens: 80,
        pricingSource: "claude-transcript",
      },
    ]);
    expect(
      claudeImportedHistory(records, records).events?.map(({ id }) => id),
    ).toEqual(imported.events?.map(({ id }) => id));
  });

  test("deduplicates usage snapshots and preserves separate model totals", () => {
    const first = assistant("first", "request-1", []);
    const complete = {
      ...assistant("second", "request-1", []),
      message: { ...first.message, usage: { ...usage, output_tokens: 25 } },
    };
    const other = assistant("third", "request-2", [], "claude-opus-5-5");
    const synthetic = assistant(
      "synthetic",
      "request-synthetic",
      [],
      "<synthetic>",
    );
    const imported = claudeTranscriptMetadata([
      first,
      complete,
      other,
      synthetic,
    ]);
    expect(imported.model).toBe("claude-opus-5-5");
    expect(
      imported.usage?.map(({ model, outputTokens }) => ({
        model,
        outputTokens,
      })),
    ).toEqual([
      { model: "claude-sonnet-5", outputTokens: 25 },
      { model: "claude-opus-5-5", outputTokens: 20 },
    ]);
    expect(imported).not.toHaveProperty("estimatedCost");
  });

  test("prefers complete recorded cost snapshots without adding message usage twice", () => {
    const cost = {
      type: "cost-state",
      totalCostUSD: 0.75,
      hasUnknownModelCost: false,
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 400,
          thinkingTokens: 50,
          costUSD: 0.75,
        },
      },
    };
    const record = assistant("first", "request-1", []);
    expect(claudeTranscriptMetadata([record, cost])).toMatchObject({
      estimatedCost: 0.75,
      usage: [
        {
          model: "claude-sonnet-5",
          inputTokens: 100,
          reasoningTokens: 50,
          estimatedCost: 0.75,
        },
      ],
    });
    const unknown = claudeTranscriptMetadata([
      record,
      { ...cost, hasUnknownModelCost: true },
    ]);
    expect(unknown).not.toHaveProperty("estimatedCost");
    expect(unknown.usage?.[0]).not.toHaveProperty("estimatedCost");
    const stale = claudeTranscriptMetadata([cost, record]);
    expect(stale).not.toHaveProperty("estimatedCost");
    expect(stale.usage?.[0]?.inputTokens).toBe(10);
    const incomplete = {
      ...record,
      message: { ...record.message, usage: undefined },
    };
    expect(claudeTranscriptMetadata([cost, incomplete])).not.toHaveProperty(
      "estimatedCost",
    );
  });

  test("does not invent usage when metadata is absent", () => {
    expect(
      claudeImportedHistory([
        { type: "user", uuid: "user", message: { content: "Prompt" } },
      ]),
    ).not.toHaveProperty("usage");
  });

  test("reads JSONL despite an incomplete trailing line", async () => {
    const folder = await mkdtemp(join(tmpdir(), "claude-history-"));
    try {
      const path = join(folder, "session.jsonl");
      await writeFile(
        path,
        `${JSON.stringify(assistant("first", "request-1", []))}\n{"type":`,
      );
      expect((await readClaudeTranscript(path)).length).toBe(1);
      await expect(
        readClaudeTranscript(join(folder, "missing")),
      ).rejects.toThrow();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
