import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runWorkflowTerminal } from "./workflows.js";

const directories: string[] = [];

afterEach(async () => {
  delete process.env.AIDE_TEST_SHOULD_NOT_LEAK;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function payload(cwd: string, script: string) {
  return {
    workflowRunId: "workflow-run-1",
    stepAttemptId: "attempt-1",
    stepId: "terminal-step",
    codebaseId: "codebase-1",
    worktreeId: "worktree-1",
    cwd,
    script,
    interpreter: "SHELL",
    sessionData: { initial: true },
    environment: { AIDE_BRANCH: "feature/workflow" },
    credentialEnvironment: [
      {
        name: "WORKFLOW_SECRET",
        credential: { id: "credential-1", kind: "TOKEN", ownerId: null },
      },
    ],
  };
}

describe("workflow terminal handler", () => {
  test("uses 0600 files, a minimal environment, writable session data, and redaction", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aide-workflow-test-cwd-"));
    directories.push(cwd);
    process.env.AIDE_TEST_SHOULD_NOT_LEAK = "unsafe-parent-value";
    const before = new Set(
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith("aide-workflow-"),
      ),
    );
    const logs: string[] = [];
    const script = `
      node -e 'const fs=require("node:fs"); const p=process.env.AIDE_SESSION_PATH; const mode=(path)=>(fs.statSync(path).mode & 0o777).toString(8); const d=JSON.parse(fs.readFileSync(p,"utf8")); d.contract={scriptMode:mode(process.argv[1]),sessionMode:mode(p),runId:process.env.AIDE_WORKFLOW_RUN_ID,stepId:process.env.AIDE_STEP_ID,branch:process.env.AIDE_BRANCH,parentLeaked:Boolean(process.env.AIDE_TEST_SHOULD_NOT_LEAK)}; fs.writeFileSync(p,JSON.stringify(d));' "$0"
      printf '%s\n' "$WORKFLOW_SECRET"
    `;
    const result = await runWorkflowTerminal(
      payload(cwd, script),
      5_000,
      new AbortController().signal,
      async (log) => {
        logs.push(log.message);
      },
      {
        agentId: "agent-1",
        reportWorktreeActivity: async () => undefined,
        claimWorkflowJobSecrets: async () => [
          { name: "WORKFLOW_SECRET", value: "top-secret-value" },
        ],
      },
    );
    expect(result.exitCode).toBe(0);
    expect(
      (result as typeof result & { sessionData: Record<string, unknown> })
        .sessionData,
    ).toMatchObject({
      initial: true,
      contract: {
        scriptMode: "600",
        sessionMode: "600",
        runId: "workflow-run-1",
        stepId: "terminal-step",
        branch: "feature/workflow",
        parentLeaked: false,
      },
    });
    expect(logs.join("\n")).not.toContain("top-secret-value");
    expect(logs.join("\n")).toContain("[REDACTED]");
    const after = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("aide-workflow-"),
    );
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });

  test("enforces timeout and cleans temporary files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aide-workflow-test-cwd-"));
    directories.push(cwd);
    const before = new Set(
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith("aide-workflow-"),
      ),
    );
    const result = await runWorkflowTerminal(
      { ...payload(cwd, "sleep 5"), credentialEnvironment: [] },
      50,
      new AbortController().signal,
      async () => undefined,
    );
    expect(result.timedOut).toBe(true);
    const after = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("aide-workflow-"),
    );
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });
});
