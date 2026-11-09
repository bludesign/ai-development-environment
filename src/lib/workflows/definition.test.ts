import { describe, expect, test } from "vitest";

import { hasConfigDescriptor } from "./config-descriptors";
import {
  computeWorkflowPathAvailability,
  emptyWorkflowDefinition,
  parseWorkflowDefinition,
  resourceManualSeedPaths,
  sanitizeWorkflowExportDefinition,
  validateWorkflowDefinition,
  workflowConnectionSummary,
  workflowTriggerChoices,
  WORKFLOW_STEP_CATALOG,
  WORKFLOW_STEP_KINDS,
  WORKFLOW_TRIGGER_CATALOG,
  WORKFLOW_TRIGGER_KINDS,
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
  test("binds a simulator inspection's agent and UUID into boot and launch steps", () => {
    const inspect = node("inspect", "SIMULATOR_INSPECT");
    inspect.config = {
      agentId: "mac",
      simulatorId: "01234567-89AB-CDEF-0123-456789ABCDEF",
    };
    const boot = node("boot", "SIMULATOR_DEVICE_ACTION");
    boot.config = {
      agentId: { source: "SESSION", path: "steps.inspect.output.agentId" },
      simulatorId: {
        source: "SESSION",
        path: "steps.inspect.output.simulatorId",
      },
      action: "BOOT",
    };
    const launch = node("launch", "SIMULATOR_APP_ACTION");
    launch.config = {
      agentId: { source: "SESSION", path: "steps.boot.output.agentId" },
      simulatorId: { source: "SESSION", path: "steps.boot.output.simulatorId" },
      action: "LAUNCH_APP",
      bundleId: "example.app",
    };
    const value = definition([inspect, boot, launch]);
    value.edges.push(
      {
        id: "inspect-boot",
        source: "inspect",
        target: "boot",
        sourceHandle: "success",
        targetHandle: "input",
      },
      {
        id: "boot-launch",
        source: "boot",
        target: "launch",
        sourceHandle: "success",
        targetHandle: "input",
      },
    );
    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);
  });

  test("accepts a connected versioned DAG", () => {
    const result = validateWorkflowDefinition(definition([node("load")]));
    expect(result.definition?.format).toBe("aide.workflow");
    expect(result.definition?.editor.displayLayout).toBe("REGULAR");
    expect(result.diagnostics).toEqual([]);
  });

  test("preserves the basic read-only display layout", () => {
    const value = definition([node("load")]);
    value.editor = { ...value.editor, displayLayout: "BASIC" };

    expect(
      validateWorkflowDefinition(value).definition?.editor.displayLayout,
    ).toBe("BASIC");
  });

  test("rejects schema versions the runtime does not understand", () => {
    const value = { ...definition([node("load")]), schemaVersion: 2 };
    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_INVALID", severity: "ERROR" }),
      ]),
    );
  });

  test("schema errors retain the affected graph row and field", () => {
    const value = definition([node("load")]);
    value.nodes[0]!.name = "";
    value.triggers[0]!.name = "";
    value.edges[0]!.sourceHandle = "";

    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SCHEMA_INVALID",
          nodeId: "load",
          path: "nodes.0.name",
        }),
        expect.objectContaining({
          code: "SCHEMA_INVALID",
          triggerId: "manual",
          path: "triggers.0.name",
        }),
        expect.objectContaining({
          code: "SCHEMA_INVALID",
          edgeId: "edge-start",
          path: "edges.0.sourceHandle",
        }),
      ]),
    );
    const malformedId = {
      ...value,
      edges: [{ ...value.edges[0], id: 42 }],
    };
    expect(validateWorkflowDefinition(malformedId).diagnostics).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_INVALID", path: "edges.0.id" }),
    );
    expect(
      validateWorkflowDefinition(malformedId).diagnostics.find(
        ({ path }) => path === "edges.0.id",
      ),
    ).not.toHaveProperty("edgeId");
  });

  test("connection errors identify their endpoints and exact edge row", () => {
    const value = definition([node("load")]);
    value.triggers[0]!.name = "Start release";
    value.nodes[0]!.name = "Load ticket";
    value.edges.push(
      { ...value.edges[0]!, target: "missing-step" },
      { ...value.edges[0]!, id: "back-to-trigger", target: "manual" },
    );

    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DUPLICATE_EDGE_ID",
          edgeId: "edge-start",
          path: "edges.1",
          message: expect.stringContaining(
            "Start release (Success) → Missing node (missing-step)",
          ),
        }),
        expect.objectContaining({
          code: "EDGE_ENDPOINT_MISSING",
          edgeId: "edge-start",
          path: "edges.1",
          message: expect.stringContaining("missing-step"),
        }),
        expect.objectContaining({
          code: "TRIGGER_HAS_INPUT",
          triggerId: "manual",
          edgeId: "back-to-trigger",
          path: "edges.2",
        }),
      ]),
    );
  });

  test("duplicate graph IDs retain row locations and trigger targets", () => {
    const value = definition([node("load")]);
    value.triggers.push({ ...value.triggers[0]! });
    value.nodes.push({ ...value.nodes[0]! });

    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DUPLICATE_NODE_ID",
          triggerId: "manual",
          path: "triggers.1.id",
        }),
        expect.objectContaining({
          code: "DUPLICATE_NODE_ID",
          nodeId: "load",
          path: "nodes.1.id",
        }),
      ]),
    );
  });

  test("connection summaries resolve authored names, catalog names, and choices", () => {
    const value = definition([node("notify", "NOTIFICATION_SEND")]);
    value.triggers[0] = {
      ...value.triggers[0]!,
      name: "Release menu",
      kind: "MANUAL_CHOICE",
      config: { choices: [{ key: "ship", label: "Ship release" }] },
    };
    value.nodes[0]!.name = "Announce release";
    const edge = { ...value.edges[0]!, sourceHandle: "ship" };

    expect(workflowConnectionSummary(value, edge)).toBe(
      "Release menu (Ship release) → Announce release",
    );
    delete value.nodes[0]!.name;
    expect(workflowConnectionSummary(value, edge)).toContain(
      WORKFLOW_STEP_CATALOG.find(({ kind }) => kind === "NOTIFICATION_SEND")!
        .label,
    );
    expect(
      workflowConnectionSummary(value, { ...edge, sourceHandle: "removed" }),
    ).toContain('Release menu (Removed option "removed")');
    expect(
      workflowConnectionSummary(value, { ...edge, source: "missing-trigger" }),
    ).toContain("Missing node (missing-trigger)");
    expect(
      workflowConnectionSummary(
        { nodes: [{ id: "custom", kind: "UNKNOWN_KIND" }], triggers: [] },
        { source: "custom", target: "custom", sourceHandle: "success" },
      ),
    ).toBe("custom (Success) → custom");
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

  test("secures Jira issue commands with an account-ID allow-list", () => {
    const value = definition([node("notify", "NOTIFICATION_SEND")]);
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "JIRA_ISSUE_COMMAND",
      config: { commandPattern: "/fix" },
    };
    // A Jira comment is untrusted input, so the same two guards apply as on
    // GitHub — only keyed on account ID, since Jira has no stable handle.
    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ISSUE_COMMAND_ALLOWLIST_REQUIRED",
          message: expect.stringContaining("Jira account ID"),
        }),
        expect.objectContaining({ code: "ISSUE_COMMAND_PATTERN_ANCHORED" }),
      ]),
    );

    value.triggers[0]!.config = {
      allowedAccountIds: ["5b10a2844c20165700ede21g"],
      commandPattern: "^/fix$",
    };
    expect(validateWorkflowDefinition(value).diagnostics).not.toEqual(
      expect.arrayContaining([
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

  test("resource-manual triggers seed their configured resource context", () => {
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
    expect(before).toContain("pr.number");
    expect(before).toContain("repo.displayOrigin");
    expect(before).not.toContain("pr.*");
    expect(before).not.toContain("worktree.*");
    expect(before).not.toContain("build.*");
  });

  test("requires an explicit loader before consuming live pull-request fields", () => {
    const consume = node("consume", "NOTIFICATION_SEND");
    consume.requiredPaths = ["pr.state"];
    consume.config = { body: "PR state: {{pr.state}}" };
    const direct = definition([consume]);
    direct.triggers[0] = {
      ...direct.triggers[0]!,
      kind: "RESOURCE_MANUAL",
      config: { resourceKind: "PULL_REQUEST" },
    };
    expect(validateWorkflowDefinition(direct).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REQUIREMENT_UNSATISFIED",
          nodeId: "consume",
        }),
      ]),
    );

    const load = node("load", "GITHUB_LOAD_PR");
    const explicit = definition([load, consume]);
    explicit.triggers[0] = {
      ...explicit.triggers[0]!,
      kind: "RESOURCE_MANUAL",
      config: { resourceKind: "PULL_REQUEST" },
    };
    explicit.edges.push({
      id: "load-consume",
      source: "load",
      target: "consume",
      sourceHandle: "success",
      targetHandle: "input",
    });
    expect(validateWorkflowDefinition(explicit).diagnostics).toEqual([]);
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

  test("optional config keys do not become publish requirements", () => {
    // `runId` is optional on RUN_PAUSE, the way `jiraIssueKey` is on the run
    // steps: the adapter falls back to session data and treats an empty value as
    // absent, so binding one must not demand the path be guaranteed.
    const value = definition([node("pause", "RUN_PAUSE")]);
    value.nodes[0]!.config = {
      runId: { source: "SESSION", path: "run.id" },
    };

    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);
  });

  test("removes the retired Jira summary binding from AI run actions", () => {
    const run = node("commit", "RUN_CREATE_SESSION");
    run.config = {
      model: "gpt-5",
      prompt: "Commit the staged changes",
      jiraSummary: { source: "SESSION", path: "ticket.status" },
    };
    const value = definition([run]);
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "RESOURCE_MANUAL",
      config: { resourceKind: "WORKTREE" },
    };

    expect(parseWorkflowDefinition(value).nodes[0]?.config).not.toHaveProperty(
      "jiraSummary",
    );
    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);
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

  test("choice triggers route out of a handle named after each option", () => {
    const value = definition([node("notify", "NOTIFICATION_SEND")]);
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "MANUAL_CHOICE",
      config: { choices: [{ key: "draft", label: "Draft" }] },
    };
    value.edges[0] = { ...value.edges[0]!, sourceHandle: "draft" };

    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);
    expect(workflowTriggerChoices(value.triggers[0].config)).toEqual([
      { key: "draft", label: "Draft", description: "" },
    ]);
  });

  test("choice triggers need options, and edges that still name one", () => {
    const value = definition([node("notify", "NOTIFICATION_SEND")]);
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "MANUAL_CHOICE",
      config: {},
    };
    // The default `success` handle belongs to no option, so the step it feeds
    // could never run.
    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TRIGGER_CHOICES_REQUIRED" }),
        expect.objectContaining({
          code: "TRIGGER_CHOICE_HANDLE_UNKNOWN",
          edgeId: "edge-start",
          path: "edges.0.sourceHandle",
          message: expect.stringContaining('Removed option "success"'),
        }),
      ]),
    );
  });

  test("a repeated choice key is reported rather than silently collapsed", () => {
    const value = definition([node("notify", "NOTIFICATION_SEND")]);
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "MANUAL_CHOICE",
      config: {
        choices: [
          { key: "draft", label: "Draft" },
          { key: "draft", label: "Draft again" },
        ],
      },
    };
    value.edges[0] = { ...value.edges[0]!, sourceHandle: "draft" };

    expect(validateWorkflowDefinition(value).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TRIGGER_CHOICES_REQUIRED" }),
      ]),
    );
  });

  test("resource choice triggers seed their resource kind like plain ones", () => {
    const value = definition([node("notify", "NOTIFICATION_SEND")]);
    value.nodes[0]!.config = { body: "PR {{pr.number}}" };
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "RESOURCE_MANUAL_CHOICE",
      config: {
        resourceKind: "PULL_REQUEST",
        choices: [{ key: "review", label: "Review" }],
      },
    };
    value.edges[0] = { ...value.edges[0]!, sourceHandle: "review" };

    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);
    expect(
      computeWorkflowPathAvailability(value).availableBefore.get("notify") ??
        [],
    ).toContain("pr.number");
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

describe("workflow parallel session writes", () => {
  function connect(
    value: WorkflowDefinition,
    source: string,
    target: string,
    sourceHandle = "success",
  ) {
    value.edges.push({
      id: `edge-${value.edges.length}`,
      source,
      target,
      sourceHandle,
      targetHandle: "input",
    });
  }

  function conflicts(value: WorkflowDefinition) {
    return validateWorkflowDefinition(value).diagnostics.filter(
      ({ code }) => code === "PARALLEL_WRITE_CONFLICT",
    );
  }

  test.each(["MANUAL_CHOICE", "RESOURCE_MANUAL_CHOICE"] as const)(
    "allows alternative writers from %s",
    (kind) => {
      const value = definition([node("left"), node("right")]);
      value.triggers[0] = {
        ...value.triggers[0]!,
        kind,
        config: {
          resourceKind: "WORKTREE",
          choices: [
            { key: "commit", label: "Commit" },
            { key: "skip", label: "Don't commit" },
          ],
        },
      };
      value.edges = [];
      connect(value, "manual", "left", "commit");
      connect(value, "manual", "right", "skip");

      expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);
    },
  );

  test("allows writers in opposite if branches", () => {
    const value = definition([
      node("condition", "CONTROL_IF"),
      node("left"),
      node("right"),
    ]);
    value.nodes[0]!.config = { condition: { op: "EQ", left: 1, right: 1 } };
    connect(value, "condition", "left", "true");
    connect(value, "condition", "right", "false");

    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);
  });

  test("allows the commit-or-skip workflow with nested alternatives and joins", () => {
    const value = definition([
      node("dirty", "CONTROL_IF"),
      node("stage", "WORKTREE_OPERATION"),
      node("commit-ticket"),
      node("commit", "RUN_CREATE_SESSION"),
      node("skip", "CONTROL_JOIN"),
      node("skip-ticket"),
      node("join", "CONTROL_JOIN"),
      node("push", "WORKTREE_OPERATION"),
    ]);
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "RESOURCE_MANUAL_CHOICE",
      config: {
        resourceKind: "WORKTREE",
        choices: [
          { key: "commit", label: "Commit" },
          { key: "skip", label: "Don't commit" },
        ],
      },
    };
    value.nodes[0]!.config = {
      condition: {
        op: "EQ",
        left: { source: "SESSION", path: "worktree.dirty" },
        right: true,
      },
    };
    value.edges = [];
    connect(value, "manual", "dirty", "commit");
    connect(value, "manual", "skip", "skip");
    connect(value, "dirty", "stage", "true");
    connect(value, "stage", "commit-ticket");
    connect(value, "commit-ticket", "commit");
    connect(value, "dirty", "skip", "false");
    connect(value, "skip", "skip-ticket");
    connect(value, "commit", "join");
    connect(value, "skip-ticket", "join");
    connect(value, "join", "push");

    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);
  });

  test("allows writers reached only from different triggers", () => {
    const value = definition([node("left"), node("right")]);
    value.triggers.push({ ...value.triggers[0]!, id: "other" });
    connect(value, "other", "right");

    expect(validateWorkflowDefinition(value).diagnostics).toEqual([]);

    // A common trigger makes the same two writers concurrent again.
    connect(value, "manual", "right");
    expect(conflicts(value)).toHaveLength(1);
  });

  test.each(["true", "false"])(
    "rejects conflicting fan-out within the same %s branch",
    (handle) => {
      const value = definition([
        node("condition", "CONTROL_IF"),
        node("left"),
        node("right"),
      ]);
      connect(value, "condition", "left", handle);
      connect(value, "condition", "right", handle);

      expect(conflicts(value)).toHaveLength(1);
    },
  );

  test("rejects conflicting fan-out from the same choice", () => {
    const value = definition([node("left"), node("right")]);
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "MANUAL_CHOICE",
      config: { choices: [{ key: "commit", label: "Commit" }] },
    };
    value.edges = [];
    connect(value, "manual", "left", "commit");
    connect(value, "manual", "right", "commit");

    expect(conflicts(value)).toHaveLength(1);
  });

  test("keeps conflicts between separate if decisions", () => {
    const value = definition([
      node("first", "CONTROL_IF"),
      node("second", "CONTROL_IF"),
      node("left"),
      node("right"),
    ]);
    connect(value, "manual", "second");
    connect(value, "first", "left", "true");
    connect(value, "second", "right", "false");

    expect(conflicts(value)).toHaveLength(1);
  });

  test("keeps a conflict when an alternative branch has an independent entry", () => {
    const value = definition([
      node("condition", "CONTROL_IF"),
      node("left"),
      node("bypass", "CONTROL_JOIN"),
      node("right"),
    ]);
    connect(value, "condition", "left", "true");
    connect(value, "condition", "bypass", "false");
    connect(value, "manual", "bypass");
    connect(value, "bypass", "right");

    expect(conflicts(value)).toHaveLength(1);
  });

  test("keeps conflicts after exclusive branches reconverge and fan out", () => {
    const value = definition([
      node("condition", "CONTROL_IF"),
      node("join", "CONTROL_JOIN"),
      node("left"),
      node("right"),
    ]);
    connect(value, "condition", "join", "true");
    connect(value, "condition", "join", "false");
    connect(value, "join", "left");
    connect(value, "join", "right");

    expect(conflicts(value)).toHaveLength(1);
  });

  test("does not treat command matches and completion as exclusive", () => {
    const value = definition([
      node("command", "CUSTOM_COMMAND"),
      node("left"),
      node("right"),
    ]);
    value.nodes[0]!.config = { outputPattern: "ready" };
    connect(value, "command", "left", "match");
    connect(value, "command", "right");

    expect(conflicts(value)).toHaveLength(1);
  });

  test("stays conservative when many alternative paths merge", () => {
    const value = definition([
      node("join", "CONTROL_JOIN"),
      node("left"),
      node("right"),
    ]);
    const choices = Array.from({ length: 100 }, (_, index) => ({
      key: `choice-${index}`,
      label: `Choice ${index}`,
    }));
    value.triggers[0] = {
      ...value.triggers[0]!,
      kind: "MANUAL_CHOICE",
      config: { choices },
    };
    value.edges = [];
    for (const { key } of choices) connect(value, "manual", "join", key);
    connect(value, "join", "left");
    connect(value, "manual", "right", choices.at(-1)!.key);

    expect(conflicts(value)).toHaveLength(1);
  });
});

/**
 * The catalog is what the editor palette and the MCP tools read to decide which
 * step or trigger fits a job, so an entry that only restates its own label — the
 * old `description: label` default — is worse than useless. These assertions
 * keep the three lists (kinds, catalog, config descriptors) from drifting apart.
 */
describe("workflow catalog", () => {
  const entries = [
    ...WORKFLOW_STEP_CATALOG.map((entry) => ({ ...entry, scope: "step" })),
    ...WORKFLOW_TRIGGER_CATALOG.map((entry) => ({
      ...entry,
      scope: "trigger",
    })),
  ];

  test("covers every kind exactly once", () => {
    expect(WORKFLOW_STEP_CATALOG.map(({ kind }) => kind)).toEqual([
      ...WORKFLOW_STEP_KINDS,
    ]);
    expect(WORKFLOW_TRIGGER_CATALOG.map(({ kind }) => kind)).toEqual([
      ...WORKFLOW_TRIGGER_KINDS,
    ]);
  });

  test("every entry describes itself beyond its label", () => {
    for (const entry of entries) {
      expect(entry.description.length, entry.kind).toBeGreaterThan(20);
      expect(entry.description, entry.kind).not.toBe(entry.label);
      expect(entry.details.length, entry.kind).toBeGreaterThan(
        entry.description.length,
      );
    }
  });

  test("every kind has a config descriptor backing its schema", () => {
    for (const entry of entries) {
      expect(
        hasConfigDescriptor(entry.kind, entry.scope as "step" | "trigger"),
        entry.kind,
      ).toBe(true);
      expect(entry.configSchema.properties, entry.kind).toBeDefined();
    }
  });

  test("worktree triggers advertise their full resource context", () => {
    for (const entry of WORKFLOW_TRIGGER_CATALOG.filter(({ kind }) =>
      kind.startsWith("WORKTREE_"),
    )) {
      expect(entry.seedPaths, entry.kind).toEqual(
        expect.arrayContaining([
          "worktree.*",
          "codebase.*",
          "agent.*",
          "repo.*",
          "ticket.*",
        ]),
      );
      expect(entry.seedPaths, entry.kind).toContain("pr.*");
    }
  });

  test("pull request triggers advertise correlated worktree context", () => {
    for (const kind of [
      "GITHUB_PR_STATE",
      "GITHUB_REVIEW_CHANGES_REQUESTED",
      "GITHUB_REVIEW_COMMENT",
      "GITHUB_PR_CLOSED",
      "GITHUB_PR_LABEL",
    ]) {
      const entry = WORKFLOW_TRIGGER_CATALOG.find((item) => item.kind === kind);
      expect(entry?.seedPaths, kind).toEqual(
        expect.arrayContaining([
          "repo.*",
          "pr.*",
          "ticket.*",
          "worktree.*",
          "codebase.*",
          "agent.*",
        ]),
      );
    }
  });

  test("Jira ticket updates advertise their webhook changelog", () => {
    expect(
      WORKFLOW_TRIGGER_CATALOG.find(
        ({ kind }) => kind === "JIRA_TICKET_UPDATED",
      )?.seedPaths,
    ).toContain("changelog.*");
  });

  test("worktree-producing steps advertise their refreshed resource context", () => {
    for (const kind of [
      "WORKTREE_CREATE",
      "WORKTREE_CHANGE_BRANCH",
      "WORKTREE_OPERATION",
      "WORKTREE_MOVE",
      "WORKTREE_GIT_OPERATION",
      "WORKTREE_WAIT_PUSH_READY",
    ]) {
      const entry = WORKFLOW_STEP_CATALOG.find((item) => item.kind === kind);
      expect(entry?.providedPaths, kind).toEqual(
        expect.arrayContaining([
          "worktree.*",
          "codebase.*",
          "agent.*",
          "repo.*",
          "ticket.*",
        ]),
      );
      expect(entry?.providedPaths, kind).toContain("pr.*");
    }
  });

  test("disk-space triggers advertise canonical monitor context", () => {
    for (const kind of [
      "AGENT_DISK_REPORT",
      "AGENT_DISK_THRESHOLD",
      "AGENT_DISK_STATE_CHANGED",
    ]) {
      expect(
        WORKFLOW_TRIGGER_CATALOG.find((entry) => entry.kind === kind)
          ?.seedPaths,
        kind,
      ).toEqual(expect.arrayContaining(["agent.*", "disk.*"]));
    }
    expect(
      WORKFLOW_TRIGGER_CATALOG.find(
        (entry) => entry.kind === "AGENT_DISK_CLEANUP_RESULT",
      )?.seedPaths,
    ).toEqual(expect.arrayContaining(["agent.*", "disk.*", "cleanup.*"]));
  });

  test("resource triggers advertise their guaranteed local context", () => {
    expect(
      resourceManualSeedPaths("RESOURCE_MANUAL", { resourceKind: "CODEBASE" }),
    ).toEqual(expect.arrayContaining(["codebase.*", "agent.*", "repo.*"]));
    expect(
      resourceManualSeedPaths("RESOURCE_MANUAL", { resourceKind: "BUILD" }),
    ).toEqual(
      expect.arrayContaining([
        "build.*",
        "worktree.*",
        "codebase.*",
        "agent.*",
        "repo.*",
        "ticket.*",
      ]),
    );
    expect(
      resourceManualSeedPaths("RESOURCE_MANUAL", {
        resourceKind: "AGENT_RUN",
      }),
    ).toEqual(
      expect.arrayContaining([
        "run.*",
        "worktree.*",
        "codebase.*",
        "agent.*",
        "repo.*",
        "ticket.*",
      ]),
    );
    for (const resourceKind of ["BUILD", "AGENT_RUN"]) {
      expect(
        resourceManualSeedPaths("RESOURCE_MANUAL", { resourceKind }),
        resourceKind,
      ).not.toContain("pr.*");
    }
    expect(
      resourceManualSeedPaths("RESOURCE_MANUAL", {
        resourceKind: "WORKTREE",
      }),
    ).toContain("pr.*");
    expect(
      resourceManualSeedPaths("RESOURCE_MANUAL", {
        resourceKind: "PULL_REQUEST",
      }),
    ).toEqual(["pr.number", "repo.displayOrigin"]);
    expect(
      resourceManualSeedPaths("RESOURCE_MANUAL", {
        resourceKind: "JIRA_TICKET",
      }),
    ).toEqual(expect.arrayContaining(["ticket.*", "comment.*"]));
  });

  test("control-flow steps advertise their branch handles", () => {
    const handles = (kind: string) =>
      WORKFLOW_STEP_CATALOG.find((entry) => entry.kind === kind)?.sourceHandles;
    expect(handles("CONTROL_IF")).toEqual(["true", "false"]);
    expect(handles("CONTROL_FOR_EACH")).toEqual(["body", "empty"]);
    expect(handles("CONTROL_TRY")).toEqual(["success", "catch"]);
    expect(handles("JIRA_LOAD_TICKET")).toEqual(["success", "failure"]);
    expect(handles("SAVED_COMMAND")).toEqual(["success", "failure", "match"]);
    expect(handles("CUSTOM_COMMAND")).toEqual(["success", "failure", "match"]);
  });

  test("offers a targeted live worktree refresh for Git completion conditions", () => {
    const refresh = WORKFLOW_STEP_CATALOG.find(
      (entry) => entry.kind === "WORKTREE_REFRESH_STATE",
    );
    expect(refresh).toMatchObject({
      label: "Refresh worktree",
      category: "Worktrees",
      execution: "SERVER",
      capabilityFlags: ["SERVER"],
      requiredPaths: ["worktree.id"],
      providedPaths: [
        "worktree.dirty",
        "worktree.hasConflicts",
        "worktree.rebaseInProgress",
        "worktree.mergeInProgress",
      ],
      mutatesWorktree: false,
      mutatesExternal: false,
    });
    expect(refresh?.configSchema).toMatchObject({
      properties: { worktreeId: expect.any(Object) },
    });
  });

  test("validates command match configuration and isolated routing", () => {
    const definition = emptyWorkflowDefinition("Command matching");
    const command = node("command", "CUSTOM_COMMAND");
    command.config = {
      script: "serve",
      completionMode: "FIRE_AND_FORGET",
      outputPattern: "ready ([0-9]+)",
    };
    definition.nodes = [
      command,
      node("matched", "NOTIFICATION_SEND"),
      node("finished", "CONTROL_JOIN"),
    ];
    definition.edges = [
      {
        id: "start",
        source: "manual",
        target: "command",
        sourceHandle: "success",
        targetHandle: "input",
      },
      {
        id: "match",
        source: "command",
        target: "matched",
        sourceHandle: "match",
        targetHandle: "input",
      },
      {
        id: "matched-finished",
        source: "matched",
        target: "finished",
        sourceHandle: "success",
        targetHandle: "input",
      },
      {
        id: "success-finished",
        source: "command",
        target: "finished",
        sourceHandle: "success",
        targetHandle: "input",
      },
    ];

    const diagnostics = validateWorkflowDefinition(definition).diagnostics;
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "COMMAND_MATCH_REQUIRES_WAIT" }),
        expect.objectContaining({ code: "COMMAND_MATCH_BRANCH_RECONVERGES" }),
      ]),
    );

    definition.nodes[0]!.config = {
      script: "serve",
      completionMode: "WAIT_FOR_EXIT",
    };
    expect(validateWorkflowDefinition(definition).diagnostics).toContainEqual(
      expect.objectContaining({ code: "COMMAND_MATCH_PATTERN_REQUIRED" }),
    );
  });

  test("choice triggers leave their handles to config", () => {
    const choice = WORKFLOW_TRIGGER_CATALOG.find(
      ({ kind }) => kind === "MANUAL_CHOICE",
    );
    expect(choice?.sourceHandles).toEqual([]);
  });
});
