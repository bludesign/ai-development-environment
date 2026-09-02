import { describe, expect, test } from "vitest";

import { hasConfigDescriptor } from "./config-descriptors";
import {
  computeWorkflowPathAvailability,
  emptyWorkflowDefinition,
  parseWorkflowDefinition,
  resourceManualSeedPaths,
  sanitizeWorkflowExportDefinition,
  validateWorkflowDefinition,
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
        expect.objectContaining({ code: "TRIGGER_CHOICE_HANDLE_UNKNOWN" }),
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
