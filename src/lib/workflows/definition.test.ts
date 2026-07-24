import { describe, expect, test } from "vitest";

import {
  computeWorkflowPathAvailability,
  emptyWorkflowDefinition,
  sanitizeWorkflowExportDefinition,
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowNodeDefinition,
} from "./definition";

function node(
  id: string,
  kind: WorkflowNodeDefinition["kind"] = "JIRA_LOAD_TICKET",
): WorkflowNodeDefinition {
  return {
    id,
    kind,
    name: id,
    position: { x: 200, y: 100 },
    config: {},
    requiredPaths: [],
    providedPaths: [],
    retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
    failurePolicy: "FAIL",
  };
}

function definition(nodes: WorkflowNodeDefinition[]): WorkflowDefinition {
  const value = emptyWorkflowDefinition("Test");
  return {
    ...value,
    nodes,
    edges: nodes.length
      ? [
          {
            id: "edge-start",
            source: "manual",
            target: nodes[0]!.id,
            sourceHandle: "success",
            targetHandle: "input",
          },
        ]
      : [],
  };
}

describe("workflow definition validation", () => {
  test("accepts a connected versioned DAG", () => {
    const result = validateWorkflowDefinition(definition([node("load")]));
    expect(result.definition?.format).toBe("aide.workflow");
    expect(result.diagnostics).toEqual([]);
  });

  test("rejects schema versions the runtime does not understand", () => {
    const value = { ...definition([node("load")]), schemaVersion: 2 };
    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_INVALID", severity: "ERROR" }),
      ]),
    );
  });

  test("rejects cycles and unreachable nodes", () => {
    const value = definition([node("first"), node("second")]);
    value.edges.push(
      {
        id: "first-second",
        source: "first",
        target: "second",
        sourceHandle: "success",
        targetHandle: "input",
      },
      {
        id: "second-first",
        source: "second",
        target: "first",
        sourceHandle: "success",
        targetHandle: "input",
      },
    );
    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DAG_CYCLE" })]),
    );

    const unreachable = definition([node("reachable"), node("orphan")]);
    expect(validateWorkflowDefinition(unreachable).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNREACHABLE_STEP", nodeId: "orphan" }),
      ]),
    );
  });

  test("requires explicit joins and propagated session requirements", () => {
    const value = definition([
      node("left"),
      node("right"),
      node("merge", "JIRA_TRANSITION"),
    ]);
    value.edges.push(
      {
        id: "start-right",
        source: "manual",
        target: "right",
        sourceHandle: "success",
        targetHandle: "input",
      },
      {
        id: "left-merge",
        source: "left",
        target: "merge",
        sourceHandle: "success",
        targetHandle: "input",
      },
      {
        id: "right-merge",
        source: "right",
        target: "merge",
        sourceHandle: "success",
        targetHandle: "input",
      },
    );
    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "EXPLICIT_JOIN_REQUIRED",
          nodeId: "merge",
        }),
      ]),
    );

    const missing = definition([node("transition", "JIRA_TRANSITION")]);
    expect(validateWorkflowDefinition(missing).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REQUIREMENT_UNSATISFIED",
          path: "ticket.key",
        }),
      ]),
    );
  });

  test("rejects unordered writes, literal secrets, and unresolved imports", () => {
    const value = definition([node("left"), node("right")]);
    value.edges.push({
      id: "start-right",
      source: "manual",
      target: "right",
      sourceHandle: "success",
      targetHandle: "input",
    });
    value.nodes[0]!.config = { apiToken: "plaintext" };
    value.nodes[1]!.config = {
      repository: { referenceStatus: "UNRESOLVED" },
    };
    const diagnostics = validateWorkflowDefinition(value).diagnostics;
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PARALLEL_WRITE_CONFLICT" }),
        expect.objectContaining({ code: "SECRET_LITERAL", nodeId: "left" }),
        expect.objectContaining({
          code: "UNRESOLVED_REFERENCE",
          nodeId: "right",
        }),
      ]),
    );
  });

  test("requires pinned sub-workflows and secured issue commands", () => {
    const value = definition([node("child", "CONTROL_SUBWORKFLOW")]);
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "GITHUB_ISSUE_COMMAND",
      config: { commandPattern: "/fix" },
    };
    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SUBWORKFLOW_VERSION_REQUIRED" }),
        expect.objectContaining({ code: "ISSUE_COMMAND_ALLOWLIST_REQUIRED" }),
        expect.objectContaining({ code: "ISSUE_COMMAND_PATTERN_ANCHORED" }),
      ]),
    );
  });

  test("validates interpolated session paths and propagates requirements", () => {
    const value = definition([node("notify", "NOTIFICATION_SEND")]);
    value.nodes[0]!.config = {
      body: "Ticket {{ticket.key}}",
      malformed: "{{ ticket key }}",
    };
    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SESSION_BINDING_INVALID",
          nodeId: "notify",
        }),
        expect.objectContaining({
          code: "REQUIREMENT_UNSATISFIED",
          nodeId: "notify",
          path: "ticket.key",
        }),
      ]),
    );
  });

  test("computeWorkflowPathAvailability scopes availability to reachable branches", () => {
    const value = definition([node("left"), node("right")]);
    value.edges.push({
      id: "start-right",
      source: "manual",
      target: "right",
      sourceHandle: "success",
      targetHandle: "input",
    });
    const { availableBefore, provides } =
      computeWorkflowPathAvailability(value);

    expect(provides.get("left")).toContain("steps.left.*");
    expect(provides.get("left")).toContain("ticket.*");

    const rightAvailable = availableBefore.get("right") ?? [];
    // The parallel branch cannot see the sibling's step output...
    expect(rightAvailable).not.toContain("steps.left.*");
    // ...but always has the guaranteed workflow identity.
    expect(rightAvailable).toContain("workflow.*");
  });

  test("resource-manual triggers seed only their configured resource kind", () => {
    const value = definition([node("notify", "NOTIFICATION_SEND")]);
    value.nodes[0]!.config = { body: "PR {{pr.number}}" };
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "RESOURCE_MANUAL",
      config: { resourceKind: "PULL_REQUEST" },
    };

    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);

    const { availableBefore } = computeWorkflowPathAvailability(value);
    const before = availableBefore.get("notify") ?? [];
    // PULL_REQUEST seeds pr.* and repo.* — but not another kind's paths.
    expect(before).toContain("pr.*");
    expect(before).toContain("repo.*");
    expect(before).not.toContain("ticket.*");
  });

  test("a loader step may optionally read the namespace it provides", () => {
    // JIRA_LOAD_TICKET establishes `ticket.*`. Binding its issueKey to the
    // (optional) seeded ticket key is the runtime "unwrap" — it must publish
    // even though ticket.key is not guaranteed, and still guarantee ticket.*
    // for a downstream consumer.
    const load = node("load", "JIRA_LOAD_TICKET");
    load.config = { issueKey: { source: "SESSION", path: "ticket.key" } };
    const notify = node("notify", "NOTIFICATION_SEND");
    notify.config = { body: "{{ticket.status}}" };
    const value = definition([load, notify]);
    value.edges.push({
      id: "load-notify",
      source: "load",
      target: "notify",
      sourceHandle: "success",
      targetHandle: "input",
    });

    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);

    const { availableBefore } = computeWorkflowPathAvailability(value);
    expect(availableBefore.get("notify") ?? []).toContain("ticket.*");
  });

  test("non-provider steps still hard-require their session bindings", () => {
    // JIRA_TRANSITION does not provide ticket.*, so a ticket.key binding stays
    // a publish requirement — the unwrap relaxation is scoped to self-provides.
    const value = definition([node("move", "JIRA_TRANSITION")]);
    value.nodes[0]!.config = {
      issueKey: { source: "SESSION", path: "ticket.key" },
      transitionId: "31",
    };
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "RESOURCE_MANUAL",
      config: { resourceKind: "CODEBASE" },
    };
    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REQUIREMENT_UNSATISFIED",
          path: "ticket.key",
        }),
      ]),
    );
  });

  test("worktree resource-manual triggers seed the linked ticket", () => {
    const value = definition([node("notify", "NOTIFICATION_SEND")]);
    value.nodes[0]!.config = { body: "{{worktree.branch}} — {{ticket.key}}" };
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "RESOURCE_MANUAL",
      config: { resourceKind: "WORKTREE" },
    };

    // The worktree's optional Jira ticket is part of the seed contract, so a
    // step binding to ticket.* validates alongside worktree.*.
    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);

    const before =
      computeWorkflowPathAvailability(value).availableBefore.get("notify") ??
      [];
    expect(before).toContain("worktree.*");
    expect(before).toContain("ticket.*");
  });

  test("resource-manual triggers require a resource kind", () => {
    const value = definition([node("notify", "NOTIFICATION_SEND")]);
    value.nodes[0]!.config = { body: "PR {{pr.number}}" };
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "RESOURCE_MANUAL",
      config: {},
    };
    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "RESOURCE_KIND_REQUIRED" }),
        // ...and without a kind the resource paths are no longer guaranteed.
        expect.objectContaining({
          code: "REQUIREMENT_UNSATISFIED",
          path: "pr.number",
        }),
      ]),
    );
  });

  test("strips secret literals and machine paths from exports", () => {
    const value = definition([node("terminal", "TERMINAL_RUN")]);
    value.nodes[0]!.config = {
      apiToken: "secret-value",
      credentialId: "credential-1",
      cwd: "/Users/dev/worktree",
      sessionPath: "ticket.key",
    };
    expect(sanitizeWorkflowExportDefinition(value).nodes[0]!.config).toEqual({
      apiToken: null,
      credentialId: "credential-1",
      cwd: null,
      sessionPath: "ticket.key",
    });
  });
});
