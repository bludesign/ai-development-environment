export const WORKFLOW_TERMINAL_JOB_KIND = "workflow.terminal.run";
export const WORKFLOW_GIT_CHECKPOINT_JOB_KIND = "workflow.git.checkpoint";
export const WORKFLOW_JOB_KINDS = [
  WORKFLOW_TERMINAL_JOB_KIND,
  WORKFLOW_GIT_CHECKPOINT_JOB_KIND,
] as const;

export type WorkflowCredentialEnvironment = {
  name: string;
  credential: {
    id: string;
    kind: string;
    ownerId: string | null;
  };
};

export type WorkflowTerminalPayload = {
  workflowRunId: string;
  stepAttemptId: string;
  stepId: string;
  codebaseId: string;
  worktreeId: string | null;
  cwd: string;
  script: string;
  interpreter: "SHELL" | "NODE";
  sessionData: Record<string, unknown>;
  environment: Record<string, string>;
  credentialEnvironment: WorkflowCredentialEnvironment[];
};

export type WorkflowGitCheckpointReference = {
  headSha: string | null;
  branch: string | null;
  upstreamSha: string | null;
  indexTree: string | null;
  worktreeTree: string | null;
  refName: string | null;
};

export type WorkflowGitCheckpointPayload = {
  operation: "CAPTURE" | "COMPARE" | "RESTORE";
  workflowRunId: string;
  stepAttemptId: string;
  cwd: string;
  kind: string;
  checkpoint: WorkflowGitCheckpointReference | null;
  stash: boolean;
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, name: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.length || value.length > maximum) {
    throw new Error(
      `${name} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null || value === undefined
    ? null
    : stringValue(value, name);
}

function checkpointReference(
  value: unknown,
): WorkflowGitCheckpointReference | null {
  if (value === null || value === undefined) return null;
  const checkpoint = objectValue(value, "checkpoint");
  return {
    headSha: nullableString(checkpoint.headSha, "checkpoint.headSha"),
    branch: nullableString(checkpoint.branch, "checkpoint.branch"),
    upstreamSha: nullableString(
      checkpoint.upstreamSha,
      "checkpoint.upstreamSha",
    ),
    indexTree: nullableString(checkpoint.indexTree, "checkpoint.indexTree"),
    worktreeTree: nullableString(
      checkpoint.worktreeTree,
      "checkpoint.worktreeTree",
    ),
    refName: nullableString(checkpoint.refName, "checkpoint.refName"),
  };
}

export function parseWorkflowTerminalPayload(
  value: unknown,
): WorkflowTerminalPayload {
  const payload = objectValue(value, "workflow terminal payload");
  const interpreter = stringValue(
    payload.interpreter ?? "SHELL",
    "interpreter",
  );
  if (interpreter !== "SHELL" && interpreter !== "NODE") {
    throw new Error("interpreter must be SHELL or NODE");
  }
  const environment = objectValue(payload.environment ?? {}, "environment");
  const normalizedEnvironment = Object.fromEntries(
    Object.entries(environment).map(([name, entry]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
        throw new Error(`Invalid environment variable name: ${name}`);
      }
      return [name, stringValue(entry, `environment.${name}`, 100_000)];
    }),
  );
  const credentials = Array.isArray(payload.credentialEnvironment)
    ? payload.credentialEnvironment
    : [];
  return {
    workflowRunId: stringValue(payload.workflowRunId, "workflowRunId", 200),
    stepAttemptId: stringValue(payload.stepAttemptId, "stepAttemptId", 200),
    stepId: stringValue(payload.stepId, "stepId", 200),
    codebaseId: stringValue(payload.codebaseId, "codebaseId", 200),
    worktreeId: nullableString(payload.worktreeId, "worktreeId"),
    cwd: stringValue(payload.cwd, "cwd", 10_000),
    script: stringValue(payload.script, "script", 1_000_000),
    interpreter,
    sessionData: objectValue(payload.sessionData, "sessionData"),
    environment: normalizedEnvironment,
    credentialEnvironment: credentials.map((entry, index) => {
      const item = objectValue(entry, `credentialEnvironment[${index}]`);
      const credential = objectValue(
        item.credential,
        `credentialEnvironment[${index}].credential`,
      );
      const name = stringValue(
        item.name,
        `credentialEnvironment[${index}].name`,
        200,
      );
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
        throw new Error(
          `Invalid credential environment variable name: ${name}`,
        );
      }
      return {
        name,
        credential: {
          id: stringValue(
            credential.id,
            `credentialEnvironment[${index}].credential.id`,
            1_000,
          ),
          kind: stringValue(
            credential.kind,
            `credentialEnvironment[${index}].credential.kind`,
            200,
          ),
          ownerId: nullableString(
            credential.ownerId,
            `credentialEnvironment[${index}].credential.ownerId`,
          ),
        },
      };
    }),
  };
}

export function parseWorkflowGitCheckpointPayload(
  value: unknown,
): WorkflowGitCheckpointPayload {
  const payload = objectValue(value, "workflow checkpoint payload");
  const operation = stringValue(payload.operation, "operation");
  if (!new Set(["CAPTURE", "COMPARE", "RESTORE"]).has(operation)) {
    throw new Error("checkpoint operation is invalid");
  }
  const checkpoint = checkpointReference(payload.checkpoint);
  if (operation !== "CAPTURE" && !checkpoint) {
    throw new Error(`${operation} requires a checkpoint`);
  }
  return {
    operation: operation as WorkflowGitCheckpointPayload["operation"],
    workflowRunId: stringValue(payload.workflowRunId, "workflowRunId", 200),
    stepAttemptId: stringValue(payload.stepAttemptId, "stepAttemptId", 200),
    cwd: stringValue(payload.cwd, "cwd", 10_000),
    kind: stringValue(payload.kind, "kind", 100),
    checkpoint,
    stash: payload.stash === true,
  };
}
