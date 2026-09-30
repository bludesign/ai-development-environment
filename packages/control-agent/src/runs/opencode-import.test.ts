import { describe, expect, test } from "vitest";
import { opencodeImportedHistory } from "./opencode-import.js";

const tokens = (input = 100) => ({
  input,
  output: 20,
  reasoning: 5,
  cache: { read: 40, write: 2 },
});
const session = {
  id: "session-1",
  time: { created: 1_000 },
  model: { providerID: "openai", id: "next-model" },
};
const assistant = (id: string, model: string, created: number) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "openai", id: model, variant: "high" },
  time: { created, completed: created + 500 },
  cost: 0.1,
  tokens: tokens(),
  finish: "stop",
  content: [{ id: `${id}-text`, type: "text", text: `Answer ${id}` }],
});

describe("OpenCode imported snapshots", () => {
  test("uses the first original user message instead of summaries or synthetic context", () => {
    const result = opencodeImportedHistory(
      { ...session, title: "Generated conversation title" },
      [
        {
          info: { id: "followup", role: "user", time: { created: 3_000 } },
          parts: [{ type: "text", text: "A later prompt" }],
        },
        {
          info: { id: "resume", role: "user", time: { created: 500 } },
          parts: [{ type: "text", synthetic: true, text: "Chat summary" }],
        },
        {
          info: {
            id: "user",
            role: "user",
            time: { created: 1_000 },
            summary: { title: "Generated title", body: "Generated summary" },
          },
          parts: [
            { id: "prompt", type: "text", text: "  Fix the imports.  " },
            {
              id: "context",
              type: "text",
              synthetic: true,
              text: "File context",
            },
            {
              id: "details",
              type: "text",
              text: "Keep the original prompt.\nInclude details.",
            },
          ],
        },
      ],
    );
    expect(result.prompt).toBe(
      "Fix the imports.\n\nKeep the original prompt.\nInclude details.",
    );
    expect(
      result.events?.find((event) => event.id === "user:part:context")
        ?.detailMarkdown,
    ).toBe("File context");
  });

  test("reads the full prompt from legacy subtask messages", () => {
    const result = opencodeImportedHistory(session, [
      {
        info: { id: "user", role: "user", time: { created: 1_000 } },
        parts: [
          {
            type: "subtask",
            prompt: "Review the changes.\nExplain each issue.",
            description: "Short review summary",
            command: "review",
          },
        ],
      },
    ]);
    expect(result.prompt).toBe("Review the changes.\nExplain each issue.");
  });

  test("does not substitute a native user summary when the original text is missing", () => {
    const result = opencodeImportedHistory(
      { ...session, title: "Generated conversation title" },
      [
        {
          id: "user",
          type: "user",
          summary: "Generated summary",
          time: { created: 1_000 },
        },
      ],
    );
    expect(result.prompt).toBeUndefined();
  });

  test("keeps whitespace-only provider parts from invalidating the import batch", () => {
    const history = opencodeImportedHistory(session, [
      {
        info: { id: "assistant", role: "assistant", time: { created: 1_000 } },
        parts: [
          { id: "reasoning", type: "reasoning", text: "\n\n  " },
          { id: "text", type: "text", text: "  \n" },
        ],
      },
    ]);
    expect(history.events?.map((event) => event.summary)).toEqual([
      "assistant message",
      "message.part.updated",
      "message.part.updated",
    ]);
    expect(history.events?.[1]?.detailMarkdown).toBe("\n\n  ");
  });

  test("imports the full native timeline, real models, tool input and reported cost", () => {
    const first = {
      ...assistant("first", "model-a", 2_000),
      content: [
        { id: "reason", type: "reasoning", text: "Thinking" },
        {
          id: "search",
          type: "tool",
          name: "websearch",
          time: { created: 2_000, ran: 2_100, completed: 2_200 },
          state: {
            status: "completed",
            input: { query: "OpenCode session API" },
            content: [{ type: "text", text: "Search results" }],
            structured: {},
            result: { found: true },
          },
        },
        { id: "answer", type: "text", text: "First answer" },
      ],
    };
    const result = opencodeImportedHistory({ ...session, cost: 0.25 }, [
      assistant("last", "model-b", 3_000),
      {
        id: "user",
        type: "user",
        text: "Fix imports",
        time: { created: 1_000 },
      },
      first,
      first,
    ]);
    expect(result).toMatchObject({
      model: "openai/model-b",
      effort: "high",
      prompt: "Fix imports",
      finalOutput: "Answer last",
      estimatedCost: 0.25,
      pricingSource: "opencode-history",
      usage: [
        {
          model: "openai/model-a",
          inputTokens: 100,
          cacheReadTokens: 40,
          estimatedCost: 0.1,
        },
        {
          model: "openai/model-b",
          inputTokens: 100,
          cacheReadTokens: 40,
          estimatedCost: 0.1,
        },
      ],
    });
    expect(result.events?.[0]?.id).toBe("message:user");
    expect(
      result.events?.find((event) => event.id === "first:part:search")?.raw,
    ).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          tool: "websearch",
          messageID: "first",
          state: {
            input: { query: "OpenCode session API" },
            output: "Search results",
            time: { start: 2_100, end: 2_200 },
          },
        },
      },
    });
    expect(
      opencodeImportedHistory({ ...session, cost: 0.25 }, [
        assistant("last", "model-b", 3_000),
        {
          id: "user",
          type: "user",
          text: "Fix imports",
          time: { created: 1_000 },
        },
        first,
        first,
      ]),
    ).toEqual(result);
  });

  test("handles legacy messages without charging both message and step totals", () => {
    const message = {
      info: {
        id: "assistant",
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude",
        variant: "max",
        agent: "plan",
        time: { created: 2_000 },
        cost: 0.3,
        tokens: tokens(),
      },
      parts: [
        { id: "answer", type: "text", text: "A plan" },
        { id: "step", type: "step-finish", tokens: tokens(), cost: 0.3 },
      ],
    };
    const result = opencodeImportedHistory(session, [
      {
        info: { id: "user", role: "user", time: { created: 1_000 } },
        parts: [{ type: "text", text: "Plan this" }],
      },
      message,
      message,
    ]);
    expect(result).toMatchObject({
      kind: "PLAN",
      finalOutput: "A plan",
      model: "anthropic/claude",
      effort: "max",
      usage: [{ inputTokens: 100, estimatedCost: 0.3 }],
    });
    expect(result.usage).toHaveLength(1);
  });

  test("uses legacy step usage when assistant totals are absent", () => {
    const result = opencodeImportedHistory(session, [
      {
        info: {
          id: "assistant",
          role: "assistant",
          providerID: "openai",
          modelID: "model-a",
          time: { created: 2_000 },
        },
        parts: [{ type: "step-finish", tokens: tokens(), cost: 0 }],
      },
    ]);
    expect(result.usage?.[0]).toMatchObject({
      inputTokens: 100,
      estimatedCost: 0,
    });
  });

  test("does not treat reasoning, tool output, compaction or user text as the final answer", () => {
    const result = opencodeImportedHistory(session, [
      assistant("final", "model-a", 2_000),
      {
        ...assistant("tools", "model-a", 3_000),
        finish: "tool-calls",
        content: [
          { type: "reasoning", text: "Reasoning" },
          { type: "text", text: "Looking up" },
        ],
      },
      {
        info: {
          id: "summary",
          role: "assistant",
          summary: true,
          time: { created: 4_000 },
        },
        parts: [{ type: "text", text: "Compaction summary" }],
      },
      {
        id: "new-user",
        type: "user",
        text: "Next prompt",
        time: { created: 5_000 },
      },
    ]);
    expect(result.finalOutput).toBe("Answer final");
  });

  test("retains unassigned historical totals across model switches and missing costs", () => {
    const result = opencodeImportedHistory(
      { ...session, cost: 0.8, tokens: tokens(500) },
      [
        assistant("a", "model-a", 2_000),
        { ...assistant("b", "model-b", 3_000), cost: undefined },
      ],
    );
    expect(
      result.usage?.find((usage) => usage.model === "openai/model-b")
        ?.estimatedCost,
    ).toBeUndefined();
    expect(
      result.usage?.find((usage) => usage.model === "unknown")?.inputTokens,
    ).toBe(300);
    expect(result.estimatedCost).toBe(0.8);
    expect(opencodeImportedHistory(session, []).usage).toBeUndefined();
    expect(
      opencodeImportedHistory(
        {
          ...session,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
        },
        [],
      ),
    ).toMatchObject({ usage: [], estimatedCost: 0 });
  });

  test("imports failed and aborted responses accurately", () => {
    expect(
      opencodeImportedHistory(session, [
        {
          ...assistant("error", "model-a", 2_000),
          error: { type: "unknown", message: "Provider failed" },
        },
      ]).status,
    ).toBe("FAILED");
    expect(
      opencodeImportedHistory(session, [
        {
          info: {
            id: "aborted",
            role: "assistant",
            time: { created: 2_000 },
            error: { name: "MessageAbortedError" },
          },
          parts: [],
        },
      ]).status,
    ).toBe("CANCELLED");
  });
});
