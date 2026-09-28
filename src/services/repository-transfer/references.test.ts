import { describe, expect, test } from "vitest";

import { referenceKey, workflowReferences } from "./references";

function node(kind: string, config: Record<string, unknown>) {
  return { kind, config };
}
const refs = (nodes: unknown[], triggers: unknown[] = []) =>
  workflowReferences({ nodes, triggers }, ["draftDefinition"]);

describe("portable workflow references", () => {
  test("classifies definitions, build settings, real auto-sync kinds and exact pinned versions", () => {
    const result = refs([
      node("BUILD_START", {
        configurationId: "configuration",
        scriptIds: ["script"],
        advancedSettings: { priorBuildForTestingId: "build" },
      }),
      node("CONTROL_SUBWORKFLOW", { versionId: "version" }),
      node("WORKTREE_SET_AUTO_SYNC", {
        worktreeId: "worktree",
        conflictWorkflowId: "workflow",
      }),
    ]);
    expect(result.map(({ kind, id }) => [kind, id])).toEqual([
      ["BUILD_CONFIGURATION", "configuration"],
      ["BUILD_SCRIPT", "script"],
      ["BUILD", "build"],
      ["WORKFLOW_VERSION", "version"],
      ["WORKFLOW", "workflow"],
      ["WORKTREE", "worktree"],
    ]);
    expect(result[2]?.path).toEqual([
      "draftDefinition",
      "nodes",
      0,
      "config",
      "advancedSettings",
      "priorBuildForTestingId",
    ]);
  });

  test("preserves runtime expressions and maps wrapped literals at their exact JSON paths", () => {
    const result = refs([
      node("BUILD_START", {
        configurationId: { source: "SESSION", path: "build.configurationId" },
        worktreeId: "prefix-{{worktree.id}}",
        scriptIds: [
          "fixed",
          "{{scripts[0]}}",
          { source: "LITERAL", value: "literal-{{id}}" },
        ],
      }),
      node("GITHUB_SAVE_AUTO_RETRY", {
        input: {
          source: "LITERAL",
          value: { codebaseRepositoryId: "repository", worktreeId: "worktree" },
        },
      }),
    ]);
    expect(result.map(({ id }) => id)).toEqual([
      "fixed",
      "literal-{{id}}",
      "repository",
      "worktree",
    ]);
    expect(result[1]?.path).toEqual([
      "draftDefinition",
      "nodes",
      0,
      "config",
      "scriptIds",
      2,
      "value",
    ]);
    expect(result[2]?.path).toEqual([
      "draftDefinition",
      "nodes",
      1,
      "config",
      "input",
      "value",
      "codebaseRepositoryId",
    ]);
  });

  test("keeps provider run IDs, Jira keys and graph IDs out of local mapping", () => {
    const result = refs([
      node("JIRA_LOAD_TICKET", { issueKey: "MOBILE-42" }),
      node("GITHUB_DISPATCH_WORKFLOW", {
        repositoryId: "github-repo",
        workflowId: "github-workflow",
        ref: "main",
      }),
      node("GITHUB_CANCEL_WORKFLOW_RUN", {
        codebaseRepositoryId: "local-repo",
        workflowRunId: "github-run",
      }),
      node("GITHUB_SAVE_AUTO_RETRY", {
        input: {
          id: "local-rule",
          codebaseRepositoryId: "local-repo",
          repositoryGithubId: "github-repo",
          targets: [
            { workflowId: "github-workflow", workflowRunId: "github-run" },
          ],
        },
      }),
      node("CONTROL_SET_VARIABLE", {
        path: "custom",
        value: { repositoryId: "arbitrary" },
        sourceStepId: "node-1",
      }),
    ]);
    expect(result.map(({ kind, id }) => [kind, id])).toEqual([
      ["GITHUB_REPOSITORY", "github-repo"],
      ["REPOSITORY", "local-repo"],
      ["AUTO_RETRY", "local-rule"],
      ["REPOSITORY", "local-repo"],
      ["GITHUB_REPOSITORY", "github-repo"],
    ]);
  });

  test("maps credential IDs and run presets without traversing scripts or credential values", () => {
    const result = refs([
      node("TERMINAL_RUN", {
        script: "echo source-id",
        credentials: [
          null,
          {
            name: "TOKEN",
            credential: {
              id: "credential-id",
              kind: "github-personal-access-token",
              ownerId: "default",
            },
          },
          {
            name: "DYNAMIC",
            credential: { source: "SESSION", path: "credential" },
          },
        ],
      }),
      node("RUN_CREATE_SESSION", {
        mcpPresetIds: ["preset"],
        attachmentIds: ["attachment"],
      }),
    ]);
    expect(result.map(({ kind, id }) => [kind, id])).toEqual([
      ["CREDENTIAL", "credential-id"],
      ["MCP_PRESET", "preset"],
      ["RUN_ATTACHMENT", "attachment"],
    ]);
    expect(result[0]?.path).toEqual([
      "draftDefinition",
      "nodes",
      0,
      "config",
      "credentials",
      1,
      "credential",
      "id",
    ]);
  });

  test("remaps typed trigger filters without confusing command definitions, runs or provider jobs", () => {
    const result = refs(
      [],
      [
        node("COMMAND_RUN_RESULT", {
          filters: {
            "repo.id": ["repo-1", "repo-2"],
            "command.id": "command-run",
            "command.commandId": "definition",
            "repo.githubId": "provider-repo",
          },
        }),
        node("GITHUB_ACTIONS_RESULT", {
          filters: { "job.id": "provider-job" },
        }),
        node("AGENT_JOB_FAILED", { filters: { "job.id": "local-job" } }),
      ],
    );
    expect(result.map(({ kind, id }) => [kind, id])).toEqual([
      ["REPOSITORY", "repo-1"],
      ["REPOSITORY", "repo-2"],
      ["GITHUB_REPOSITORY", "provider-repo"],
      ["COMMAND_RUN", "command-run"],
      ["COMMAND", "definition"],
      ["AGENT_JOB", "local-job"],
    ]);
  });

  test("ignores inactive fixed targets and tolerates unknown kinds and malformed optional JSON", () => {
    expect(
      refs([
        null,
        node("UNKNOWN_KIND", { agentId: "unknown" }),
        node("CUSTOM_COMMAND", {
          targetMode: "CONTEXT",
          agentId: "stale-agent",
          worktreeId: "stale-worktree",
        }),
        node("TERMINAL_RUN", { credentials: [null, "text", {}] }),
      ]),
    ).toEqual([]);
    expect(
      refs([
        node("CUSTOM_COMMAND", {
          targetMode: "FIXED_WORKTREE",
          agentId: "stale-agent",
          worktreeId: "selected-worktree",
        }),
      ]).map(({ kind, id }) => [kind, id]),
    ).toEqual([["WORKTREE", "selected-worktree"]]);
  });

  test("reference keys escape path segments without collisions", () => {
    expect(referenceKey("workflow", ["x/y", 0, "x~y"])).toBe(
      "workflow/ref/x%2Fy/0/x~y",
    );
    expect(referenceKey("workflow", ["x/y"])).not.toBe(
      referenceKey("workflow", ["x", "y"]),
    );
  });
});
