import { describe, expect, test } from "vitest";

import {
  parseWorkflowGitCheckpointPayload,
  parseWorkflowTerminalPayload,
} from "./workflows";

describe("workflow agent job contracts", () => {
  test("accepts descriptor-only credentials and a writable session contract", () => {
    const payload = parseWorkflowTerminalPayload({
      workflowRunId: "workflow-run-1",
      stepAttemptId: "attempt-1",
      stepId: "terminal",
      codebaseId: "codebase-1",
      worktreeId: "worktree-1",
      cwd: "/work/app",
      script: "printf done",
      interpreter: "SHELL",
      sessionData: { ticket: { key: "AIDE-1" } },
      environment: { AIDE_BRANCH: "feature/aide-1" },
      credentialEnvironment: [
        {
          name: "API_TOKEN",
          credential: { id: "credential-1", kind: "TOKEN", ownerId: null },
        },
      ],
    });
    expect(payload.credentialEnvironment[0]?.credential).toEqual({
      id: "credential-1",
      kind: "TOKEN",
      ownerId: null,
    });
    expect(payload.sessionData).toEqual({ ticket: { key: "AIDE-1" } });
  });

  test("rejects invalid environment names and oversized scripts", () => {
    const base = {
      workflowRunId: "run",
      stepAttemptId: "attempt",
      stepId: "step",
      codebaseId: "codebase",
      worktreeId: null,
      cwd: "/tmp",
      script: "true",
      interpreter: "SHELL",
      sessionData: {},
      credentialEnvironment: [],
    };
    expect(() =>
      parseWorkflowTerminalPayload({
        ...base,
        environment: { "BAD-NAME": "x" },
      }),
    ).toThrow(/environment variable name/);
    expect(() =>
      parseWorkflowTerminalPayload({
        ...base,
        environment: {},
        script: "x".repeat(1_000_001),
      }),
    ).toThrow(/script/);
  });

  test("requires checkpoint references for compare and restore", () => {
    expect(() =>
      parseWorkflowGitCheckpointPayload({
        operation: "RESTORE",
        workflowRunId: "run",
        stepAttemptId: "attempt",
        cwd: "/tmp",
        kind: "REPLAY",
        checkpoint: null,
        stash: true,
      }),
    ).toThrow(/requires a checkpoint/);
    expect(
      parseWorkflowGitCheckpointPayload({
        operation: "CAPTURE",
        workflowRunId: "run",
        stepAttemptId: "attempt",
        cwd: "/tmp",
        kind: "STEP",
        checkpoint: null,
        stash: false,
      }).operation,
    ).toBe("CAPTURE");
  });
});
