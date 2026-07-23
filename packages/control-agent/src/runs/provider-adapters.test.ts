import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  claudeAnswers,
  claudeEnvironment,
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
