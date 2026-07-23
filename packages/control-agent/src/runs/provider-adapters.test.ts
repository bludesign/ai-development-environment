import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  claudeAnswers,
  claudeEnvironment,
  claudeModelUsages,
  questionsFromInput,
} from "./claude-adapter.js";
import { codexQuestions } from "./codex-adapter.js";
import {
  opencodeEventText,
  opencodeQuestions,
  opencodeResponseText,
} from "./opencode-adapter.js";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      join(process.cwd(), "src", "runs", "fixtures", name),
      "utf8",
    ),
  );
}

describe("provider protocol fixtures", () => {
  test("normalizes Codex structured user-input requests", async () => {
    expect(codexQuestions(await fixture("codex-user-input.json"))).toEqual([
      expect.objectContaining({
        id: "database",
        header: "Database",
        prompt: "Which database should be used?",
        allowCustom: true,
        options: [
          { label: "SQLite", description: "Local and embedded" },
          { label: "Postgres", description: "Shared server" },
        ],
      }),
    ]);
  });

  test("normalizes every question in a Claude AskUserQuestion batch", async () => {
    const questions = questionsFromInput(
      await fixture("claude-ask-user-question.json"),
    );
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({ id: "scope", multiSelect: true });
    expect(questions[1]).toMatchObject({
      id: "tests",
      prompt: "Add integration tests?",
    });
    expect(claudeEnvironment().CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  });

  test("formats Claude answers as a question-text record", async () => {
    const input = await fixture("claude-ask-user-question.json");

    expect(
      claudeAnswers(input, {
        tests: { answers: ["No"] },
        scope: { answers: ["API", "UI"] },
      }),
    ).toEqual({
      "Which scope should be changed?": "API, UI",
      "Add integration tests?": "No",
    });
  });

  test("normalizes the OpenCode v2 question surface", async () => {
    expect(
      opencodeQuestions(await fixture("opencode-v2-question.json")),
    ).toEqual({
      id: "request-1",
      questions: [
        expect.objectContaining({
          id: "strategy",
          prompt: "Choose an implementation strategy",
          allowCustom: true,
        }),
      ],
    });
  });

  test("collects OpenCode response text parts as final output", () => {
    expect(
      opencodeResponseText({
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "First paragraph." },
          { type: "tool", name: "git_status" },
          { type: "text", text: "Second paragraph." },
        ],
      }),
    ).toBe("First paragraph.\n\nSecond paragraph.");
  });

  test("extracts text from OpenCode v2 message part events", () => {
    expect(
      opencodeEventText({
        type: "message.part.updated",
        data: {
          sessionID: "session-1",
          part: { type: "text", text: "Changed files listed." },
        },
      }),
    ).toBe("Changed files listed.");
  });
});

describe("claudeModelUsages", () => {
  test("lifts the per-model breakdown with real ids and cache split", () => {
    expect(
      claudeModelUsages(
        {
          num_turns: 2,
          total_cost_usd: 0.1297152,
          usage: { input_tokens: 4, output_tokens: 200 },
          modelUsage: {
            "claude-sonnet-5": {
              inputTokens: 4,
              outputTokens: 200,
              cacheReadInputTokens: 19904,
              cacheCreationInputTokens: 20122,
              costUSD: 0.1297152,
            },
          },
        },
        "sonnet",
      ),
    ).toEqual([
      {
        model: "claude-sonnet-5",
        inputTokens: 4,
        outputTokens: 200,
        cacheReadTokens: 19904,
        cacheWriteTokens: 20122,
        estimatedCost: 0.1297152,
        toolCallCount: 2,
        pricingSource: "claude-agent-sdk",
      },
    ]);
  });

  test("falls back to the run model and aggregate usage without a breakdown", () => {
    expect(
      claudeModelUsages(
        {
          num_turns: 1,
          total_cost_usd: 0.02,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 6,
          },
        },
        "sonnet",
      ),
    ).toEqual([
      {
        model: "sonnet",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 6,
        estimatedCost: 0.02,
        toolCallCount: 1,
        pricingSource: "claude-agent-sdk",
      },
    ]);
  });
});
