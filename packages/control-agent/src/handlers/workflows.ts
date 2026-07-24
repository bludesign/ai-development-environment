import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseWorkflowGitCheckpointPayload,
  parseWorkflowTerminalPayload,
} from "@ai-development-environment/agent-contract/workflows";

import { runProcess } from "../process-runner.js";
import {
  captureGitCheckpoint,
  compareGitCheckpoint,
  restoreGitCheckpoint,
} from "../runs/git-checkpoint.js";
import { createRedactor, minimalEnvironment } from "./builds.js";
import type { AgentJobHandler } from "./index.js";

const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const success = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

export const runWorkflowTerminal: AgentJobHandler = async (
  payloadValue,
  timeoutMs,
  signal,
  onLog,
  context,
) => {
  const payload = parseWorkflowTerminalPayload(payloadValue);
  const cwd = await realpath(payload.cwd);
  const information = await stat(cwd);
  if (!information.isDirectory())
    throw new Error("Workflow working directory is not a directory");
  const directory = await mkdtemp(join(tmpdir(), "aide-workflow-"));
  const extension = payload.interpreter === "NODE" ? "mjs" : "sh";
  const scriptPath = join(directory, `step.${extension}`);
  const sessionPath = join(directory, "session.json");
  try {
    await writeFile(scriptPath, `${payload.script}\n`, { mode: 0o600 });
    await writeFile(
      sessionPath,
      `${JSON.stringify(payload.sessionData, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    const secrets = payload.credentialEnvironment.length
      ? await context?.claimWorkflowJobSecrets?.()
      : [];
    if (payload.credentialEnvironment.length && !secrets) {
      throw new Error("Workflow credential transfer is unavailable");
    }
    const secretEnvironment = Object.fromEntries(
      (secrets ?? []).map(({ name, value }) => [name, value]),
    );
    const env = minimalEnvironment({
      ...payload.environment,
      ...secretEnvironment,
      AIDE_WORKFLOW_RUN_ID: payload.workflowRunId,
      AIDE_STEP_ID: payload.stepId,
      AIDE_SESSION_PATH: sessionPath,
    });
    const redact = createRedactor(env);
    const result = await runProcess({
      command:
        payload.interpreter === "NODE"
          ? process.execPath
          : process.env.SHELL || "/bin/sh",
      args: [scriptPath],
      cwd,
      env,
      timeoutMs,
      signal,
      onLog: (log) => onLog({ ...log, message: redact(log.message) }),
    });
    const sessionFile = await readFile(sessionPath);
    if (sessionFile.byteLength > MAX_SESSION_BYTES) {
      throw new Error("Workflow session data exceeded 2 MiB");
    }
    const sessionData: unknown = JSON.parse(sessionFile.toString("utf8"));
    if (
      !sessionData ||
      typeof sessionData !== "object" ||
      Array.isArray(sessionData)
    ) {
      throw new Error(
        "Workflow terminal session data must remain a JSON object",
      );
    }
    return { ...result, sessionData };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const runWorkflowGitCheckpoint: AgentJobHandler = async (
  payloadValue,
  _timeoutMs,
  signal,
) => {
  const payload = parseWorkflowGitCheckpointPayload(payloadValue);
  if (signal.aborted) return { ...success, exitCode: null, cancelled: true };
  const cwd = await realpath(payload.cwd);
  if (payload.operation === "CAPTURE") {
    const checkpoint = await captureGitCheckpoint(
      cwd,
      payload.workflowRunId,
      payload.kind,
    );
    return { ...success, checkpoint };
  }
  if (!payload.checkpoint) throw new Error("Workflow checkpoint is missing");
  if (payload.operation === "COMPARE") {
    const current = await captureGitCheckpoint(
      cwd,
      payload.workflowRunId,
      "COMPARE_CURRENT",
    );
    const comparison = await compareGitCheckpoint(
      cwd,
      payload.checkpoint,
      current,
    );
    return { ...success, comparison, current };
  }
  const stashRef = await restoreGitCheckpoint(cwd, payload.checkpoint, {
    stash: payload.stash,
    message: `AIDE workflow ${payload.workflowRunId} replay`,
  });
  const checkpoint = await captureGitCheckpoint(
    cwd,
    payload.workflowRunId,
    "RESTORED",
  );
  return { ...success, stashRef, checkpoint };
};
