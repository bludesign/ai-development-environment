import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { questionsFromInput, claudeEnvironment } from "./claude-adapter.js";
import { codexQuestions } from "./codex-adapter.js";
import { opencodeQuestions } from "./opencode-adapter.js";

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
});
