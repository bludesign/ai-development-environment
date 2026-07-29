export const COMMAND_RUN_JOB_KIND = "command.run";

export const MAX_COMMAND_OUTPUT_BATCH_CHUNKS = 200;

export type CommandRunTargetKind = "AGENT_HOME" | "WORKTREE";

export type CommandRunPayload = {
  commandRunId: string;
  attemptId: string;
  targetKind: CommandRunTargetKind;
  cwd: string | null;
  script: string;
};

export type CommandOutputChunk = {
  sequence: number;
  stream: "STDOUT" | "STDERR" | "SYSTEM";
  dataBase64: string;
  byteLength: number;
  createdAt: string;
};

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum) {
    throw new Error(
      `${name} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return value;
}

export function parseCommandRunPayload(value: unknown): CommandRunPayload {
  const payload = objectValue(value, "command run payload");
  const targetKind = stringValue(payload.targetKind, "targetKind", 20);
  if (targetKind !== "AGENT_HOME" && targetKind !== "WORKTREE") {
    throw new Error("targetKind must be AGENT_HOME or WORKTREE");
  }
  const cwd =
    payload.cwd === null || payload.cwd === undefined
      ? null
      : stringValue(payload.cwd, "cwd", 10_000);
  if (targetKind === "WORKTREE" && !cwd) {
    throw new Error("Worktree commands require cwd");
  }
  if (targetKind === "AGENT_HOME" && cwd !== null) {
    throw new Error("Agent-home commands cannot provide cwd");
  }
  const allowed = new Set([
    "commandRunId",
    "attemptId",
    "targetKind",
    "cwd",
    "script",
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected)
    throw new Error(`Unsupported command payload field: ${unexpected}`);
  return {
    commandRunId: stringValue(payload.commandRunId, "commandRunId", 200),
    attemptId: stringValue(payload.attemptId, "attemptId", 200),
    targetKind,
    cwd,
    script: stringValue(payload.script, "script", 1_000_000),
  };
}
