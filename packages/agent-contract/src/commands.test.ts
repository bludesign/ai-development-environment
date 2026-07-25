import { describe, expect, test } from "vitest";

import { parseCommandRunPayload } from "./commands";

describe("command run contract", () => {
  test("accepts agent-home and worktree payloads", () => {
    expect(
      parseCommandRunPayload({
        commandRunId: "run-1",
        attemptId: "attempt-1",
        targetKind: "AGENT_HOME",
        cwd: null,
        script: "printf ok",
      }),
    ).toMatchObject({ targetKind: "AGENT_HOME", cwd: null });
    expect(
      parseCommandRunPayload({
        commandRunId: "run-2",
        attemptId: "attempt-2",
        targetKind: "WORKTREE",
        cwd: "/tmp/repository",
        script: "printf ok",
      }),
    ).toMatchObject({ targetKind: "WORKTREE", cwd: "/tmp/repository" });
  });

  test("rejects target confusion and unexpected fields", () => {
    expect(() =>
      parseCommandRunPayload({
        commandRunId: "run-1",
        attemptId: "attempt-1",
        targetKind: "WORKTREE",
        cwd: null,
        script: "true",
      }),
    ).toThrow("require cwd");
    expect(() =>
      parseCommandRunPayload({
        commandRunId: "run-1",
        attemptId: "attempt-1",
        targetKind: "AGENT_HOME",
        cwd: null,
        script: "true",
        stdin: "unsafe",
      }),
    ).toThrow("Unsupported command payload field");
  });
});
