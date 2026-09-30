import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  codexImportedHistory,
  codexTranscriptMetadata,
  readCodexTranscriptMetadata,
} from "./codex-import.js";

const context = (model: string, turn_id = "turn-1") => ({
  type: "turn_context",
  payload: { model, effort: "high", turn_id },
});
const usage = (
  input_tokens: number,
  cached_input_tokens: number,
  output_tokens = 10,
) => ({
  input_tokens,
  cached_input_tokens,
  output_tokens,
  reasoning_output_tokens: 4,
  cache_write_input_tokens: 2,
});
const legacy = (total: unknown) => ({
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: total } },
});

describe("Codex imported transcript metadata", () => {
  test("uses per-response usage once and keeps model switches separate", () => {
    const first = {
      type: "token_usage_record",
      payload: {
        turn_id: "turn-1",
        response_id: "response-1",
        usage: usage(100, 80),
      },
    };
    const result = codexTranscriptMetadata([
      context("model-a"),
      first,
      first,
      legacy(usage(100, 80)),
      context("model-b", "turn-2"),
      {
        type: "token_usage_record",
        payload: {
          turn_id: "turn-2",
          response_id: "response-2",
          usage: usage(150, 40),
        },
      },
      legacy(usage(250, 120, 20)),
    ]);
    expect(result.model).toBe("model-b");
    expect(result.effort).toBe("high");
    expect(result.usage).toEqual([
      {
        model: "model-a",
        inputTokens: 20,
        cacheReadTokens: 80,
        cacheWriteTokens: 2,
        outputTokens: 10,
        reasoningTokens: 4,
        pricingSource: "codex-transcript",
      },
      {
        model: "model-b",
        inputTokens: 110,
        cacheReadTokens: 40,
        cacheWriteTokens: 2,
        outputTokens: 10,
        reasoningTokens: 4,
        pricingSource: "codex-transcript",
      },
    ]);
  });

  test("differences legacy cumulative totals without summing repeated snapshots", () => {
    const result = codexTranscriptMetadata([
      context("model-a"),
      legacy(usage(100, 80)),
      legacy(usage(100, 80)),
      context("model-b"),
      legacy(usage(250, 120, 30)),
    ]);
    expect(
      result.usage?.map(
        ({ model, inputTokens, cacheReadTokens, outputTokens }) => ({
          model,
          inputTokens,
          cacheReadTokens,
          outputTokens,
        }),
      ),
    ).toEqual([
      {
        model: "model-a",
        inputTokens: 20,
        cacheReadTokens: 80,
        outputTokens: 10,
      },
      {
        model: "model-b",
        inputTokens: 110,
        cacheReadTokens: 40,
        outputTokens: 20,
      },
    ]);
  });

  test("does not invent usage or a model for missing metadata", () => {
    expect(codexTranscriptMetadata([])).toEqual({
      model: undefined,
      effort: undefined,
    });
  });

  test("preserves legacy usage before an upgrade to per-response records", () => {
    const result = codexTranscriptMetadata([
      context("older-model", "older-turn"),
      legacy(usage(100, 80)),
      context("newer-model", "newer-turn"),
      {
        type: "token_usage_record",
        payload: {
          turn_id: "newer-turn",
          response_id: "newer-response",
          usage: usage(150, 40),
        },
      },
      legacy(usage(250, 120, 20)),
    ]);
    expect(result.usage).toMatchObject([
      { model: "older-model", inputTokens: 20, outputTokens: 10 },
      { model: "newer-model", inputTokens: 110, outputTokens: 10 },
    ]);
  });

  test("tolerates an incomplete trailing JSONL record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-import-"));
    try {
      const path = join(directory, "rollout.jsonl");
      await writeFile(
        path,
        `${JSON.stringify(context("model-a"))}\n${JSON.stringify(legacy(usage(100, 80)))}\n{"type":`,
      );
      expect(
        (await readCodexTranscriptMetadata(path)).usage?.[0]?.inputTokens,
      ).toBe(20);
      await expect(
        readCodexTranscriptMetadata(join(directory, "missing")),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Codex imported activity", () => {
  test("keeps tool details, chronological items, stable IDs and only the final answer", () => {
    const thread = {
      id: "thread-1",
      createdAt: 100,
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "user",
              type: "userMessage",
              content: [{ type: "text", text: "Fix it" }],
            },
            {
              id: "commentary",
              type: "agentMessage",
              phase: "commentary",
              text: "Working",
            },
            {
              id: "tool",
              type: "commandExecution",
              command: "npm test",
              aggregatedOutput: "passed",
              exitCode: 0,
              status: "completed",
            },
            {
              id: "final",
              type: "agentMessage",
              phase: "final_answer",
              text: "Fixed",
            },
          ],
        },
      ],
    };
    const result = codexImportedHistory(thread);
    expect(result.finalOutput).toBe("Fixed");
    expect(result.events).toHaveLength(4);
    expect(result.events?.[2]?.raw).toEqual({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: thread.turns[0]!.items[2],
      },
    });
    expect(result.events?.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(codexImportedHistory(thread)).toEqual(result);
  });

  test("recognizes actual plan items without inspecting text for type markers", () => {
    expect(
      codexImportedHistory({
        turns: [{ items: [{ type: "plan", text: "A plan" }] }],
      }).kind,
    ).toBe("PLAN");
    expect(
      codexImportedHistory({
        turns: [
          { items: [{ type: "agentMessage", text: 'Example: "type":"plan"' }] },
        ],
      }).kind,
    ).toBe("SESSION");
  });

  test("preserves tool progress, failed turn details and interruption status", () => {
    const history = codexImportedHistory({
      id: "thread",
      turns: [
        {
          id: "turn",
          status: "failed",
          error: { message: "Request failed" },
          items: [
            {
              id: "tool",
              type: "commandExecution",
              command: "npm test",
              status: "inProgress",
            },
          ],
        },
      ],
    });
    expect(history.status).toBe("FAILED");
    expect(history.events?.[0]).toMatchObject({
      type: "ITEM_STARTED",
      raw: { method: "item/started" },
    });
    expect(history.events?.[1]).toMatchObject({
      type: "TURN_COMPLETED",
      summary: "Request failed",
      raw: {
        method: "turn/completed",
        params: { turn: { error: "Request failed" } },
      },
    });
    expect(
      codexImportedHistory({ turns: [{ status: "interrupted", items: [] }] })
        .status,
    ).toBe("CANCELLED");
  });
});
