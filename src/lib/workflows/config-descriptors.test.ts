import { describe, expect, test } from "vitest";

import {
  getConfigDescriptor,
  requiredConfigSessionPaths,
} from "./config-descriptors";

describe("workflow config descriptors", () => {
  test("uses resource selectors for worktrees and Jira issue keys", () => {
    const runFields = getConfigDescriptor("RUN_CREATE_SESSION", "step")?.fields;

    expect(runFields?.find(({ key }) => key === "worktreeId")).toMatchObject({
      control: "resource",
      options: {
        kind: "resource",
        resource: "worktree",
        sessionPath: "worktree.id",
      },
    });
    expect(runFields?.find(({ key }) => key === "jiraIssueKey")).toMatchObject({
      control: "resource",
      options: {
        kind: "resource",
        resource: "jiraTicket",
        sessionPath: "ticket.key",
      },
    });
    expect(runFields?.find(({ key }) => key === "jiraSummary")).toBeUndefined();

    for (const kind of [
      "JIRA_LOAD_TICKET",
      "JIRA_TRANSITION",
      "JIRA_COMMENT",
      "JIRA_ASSIGN",
      "JIRA_UPDATE_FIELDS",
      "JIRA_RESOLVE_BRANCH",
    ]) {
      expect(
        getConfigDescriptor(kind, "step")?.fields.find(
          ({ key }) => key === "issueKey",
        ),
      ).toMatchObject({
        control: "resource",
        options: { kind: "resource", resource: "jiraTicket" },
      });
    }
  });

  test("uses the agent picker for agent-targeted disk actions", () => {
    for (const kind of [
      "DISK_SPACE_LOAD",
      "DISK_SPACE_REFRESH",
      "DISK_SPACE_SET_MONITORING",
      "DISK_SPACE_SET_PRESSURE_MODE",
    ]) {
      expect(
        getConfigDescriptor(kind, "step")?.fields.find(
          ({ key }) => key === "agentId",
        ),
      ).toMatchObject({
        control: "resource",
        options: {
          kind: "resource",
          resource: "agent",
          sessionPath: "agent.id",
        },
      });
    }
  });

  test("uses the saved-command picker for run saved command", () => {
    expect(
      getConfigDescriptor("SAVED_COMMAND", "step")?.fields.find(
        ({ key }) => key === "commandId",
      ),
    ).toMatchObject({
      control: "resource",
      required: true,
      options: { kind: "resource", resource: "savedCommand" },
      valueModes: ["literal", "session", "interpolation"],
    });
  });

  test("offers literal RE2 output matching on both command steps", () => {
    for (const kind of ["SAVED_COMMAND", "CUSTOM_COMMAND"]) {
      const fields = getConfigDescriptor(kind, "step")?.fields;
      expect(fields?.find(({ key }) => key === "outputPattern")).toMatchObject({
        control: "text",
        valueModes: ["literal"],
      });
      expect(
        fields?.find(({ key }) => key === "outputMatchMode"),
      ).toMatchObject({
        control: "enum",
        default: "ONCE",
      });
    }
  });

  test("uses kind-specific worktree concurrency defaults for AI runs", () => {
    const concurrency = (kind: string) =>
      getConfigDescriptor(kind, "step")?.fields.find(
        ({ key }) => key === "worktreeConcurrencyLimit",
      );

    expect(concurrency("RUN_CREATE_PLAN")).toMatchObject({
      control: "number",
      default: 0,
      minimum: 0,
      maximum: 32,
      integer: true,
    });
    for (const kind of ["RUN_CREATE_SESSION", "RUN_PLAY_PLAN"]) {
      expect(concurrency(kind)).toMatchObject({
        control: "number",
        default: 1,
        minimum: 0,
        maximum: 32,
        integer: true,
      });
    }
    expect(concurrency("RUN_FOLLOW_UP")).toMatchObject({
      control: "number",
      default: undefined,
      minimum: 0,
      maximum: 32,
      integer: true,
    });
  });

  test("defaults imported coverage build names to the workflow name", () => {
    expect(
      getConfigDescriptor("BUILD_IMPORT_COVERAGE", "step")?.fields.find(
        ({ key }) => key === "buildName",
      ),
    ).toMatchObject({
      control: "text",
      default: "{{workflow.name}}",
      label: "Build name",
    });
  });

  test("allows interpolation wherever the runtime resolves strings", () => {
    const interpolates = (
      kind: string,
      scope: "step" | "trigger",
      key: string,
    ) =>
      getConfigDescriptor(kind, scope)
        ?.fields.find((field) => field.key === key)
        ?.valueModes?.includes("interpolation") ?? false;

    // Scalars the author types, whether free text or a resource identifier.
    expect(interpolates("RUN_CREATE_SESSION", "step", "prompt")).toBe(true);
    expect(interpolates("RUN_CREATE_SESSION", "step", "worktreeId")).toBe(true);
    // Composite values — every string inside them is resolved too.
    expect(interpolates("RUN_CREATE_SESSION", "step", "attachmentIds")).toBe(
      true,
    );
    expect(interpolates("TERMINAL_RUN", "step", "environment")).toBe(true);
    expect(interpolates("MCP_CALL", "step", "arguments")).toBe(true);
    expect(interpolates("CONTROL_IF", "step", "condition")).toBe(true);
    expect(interpolates("HUMAN_CHOICE", "step", "options")).toBe(true);
    // Triggers resolve their config against the event payload.
    expect(interpolates("GITHUB_PR_STATE", "trigger", "filters")).toBe(true);
    expect(
      interpolates("GITHUB_ISSUE_COMMAND", "trigger", "commandPattern"),
    ).toBe(true);

    // Controls with no string to interpolate stay literal.
    expect(interpolates("JIRA_LOAD_TICKET", "step", "force")).toBe(false);
    expect(interpolates("GITHUB_MERGE_PR", "step", "method")).toBe(false);
    expect(interpolates("CONTROL_DELAY", "step", "seconds")).toBe(false);
  });

  test("keeps command patterns free of session bindings", () => {
    // The matcher compiles the pattern itself, so an object would break it.
    expect(
      getConfigDescriptor("GITHUB_ISSUE_COMMAND", "trigger")
        ?.fields.find(({ key }) => key === "commandPattern")
        ?.valueModes?.includes("session"),
    ).toBe(false);
  });

  test("only required config keys make their bindings prerequisites", () => {
    const paths = requiredConfigSessionPaths("RUN_CREATE_SESSION", "step", {
      worktreeId: { source: "SESSION", path: "worktree.id" },
      // Optional: a worktree may carry no Jira ticket, and the run starts
      // without one, so this must not hold the step back.
      jiraIssueKey: { source: "SESSION", path: "ticket.key" },
      model: { source: "SESSION", path: "run.model" },
      prompt: "Rebase onto {{worktree.baseBranch}}",
    });

    expect([...paths]).toEqual(
      expect.arrayContaining(["run.model", "worktree.baseBranch"]),
    );
    expect(paths.has("ticket.key")).toBe(false);
    // `worktreeId` is optional too — RUN_CREATE_SESSION requires `worktree.id`
    // through the catalog instead, which stays strict.
    expect(paths.has("worktree.id")).toBe(false);
  });

  test("keeps undescribed config keys strict", () => {
    // The raw-JSON escape hatch says nothing about optionality, and a kind with
    // no descriptor at all even less, so both keep every binding required.
    expect([
      ...requiredConfigSessionPaths("RUN_CREATE_SESSION", "step", {
        someAdapterKey: { source: "SESSION", path: "ticket.key" },
      }),
    ]).toEqual(["ticket.key"]);
    expect([
      ...requiredConfigSessionPaths("NOT_A_KIND", "step", {
        anything: "{{ticket.key}}",
      }),
    ]).toEqual(["ticket.key"]);
  });

  test("edits terminal credential entries as structured JSON", () => {
    const credentialField = getConfigDescriptor(
      "TERMINAL_RUN",
      "step",
    )?.fields.find(({ key }) => key === "credentials");

    expect(credentialField).toMatchObject({
      control: "json",
      key: "credentials",
    });
  });

  test("offers wait timing on every step that parks on external work", () => {
    const timingKeys = (kind: string) =>
      getConfigDescriptor(kind, "step")
        ?.fields.filter(({ key }) =>
          ["cadenceSeconds", "timeoutSeconds"].includes(key),
        )
        .map(({ key }) => key) ?? [];

    for (const kind of [
      "BUILD_START",
      "RUN_CREATE_SESSION",
      "WORKTREE_OPERATION",
      "WORKTREE_SNAPSHOT",
      "CUSTOM_COMMAND",
      "COMMAND_RERUN",
      "BUILD_REBUILD",
      "BUILD_DATA_REFRESH",
      "SIGNING_REFRESH",
      "SIGNING_SYNC_PROFILE",
      "SIGNING_DELETE_EXPIRED",
      "SKILL_APPLY",
      "CONTROL_SUBWORKFLOW",
      "TERMINAL_RUN",
      "DISK_SPACE_REFRESH",
    ]) {
      expect(timingKeys(kind)).toEqual(["cadenceSeconds", "timeoutSeconds"]);
    }

    // Kinds that already described a timing key keep exactly one of it.
    expect(timingKeys("GITHUB_WAIT_CHECKS")).toEqual([
      "cadenceSeconds",
      "timeoutSeconds",
    ]);
    expect(timingKeys("CONTROL_WAIT_UNTIL")).toEqual([
      "cadenceSeconds",
      "timeoutSeconds",
    ]);

    // A person answers these, so there is nothing to poll for.
    expect(timingKeys("HUMAN_CONFIRM")).toEqual(["timeoutSeconds"]);
    expect(timingKeys("HUMAN_CHOICE")).toEqual(["timeoutSeconds"]);

    // Steps that finish inline gain neither.
    expect(timingKeys("JIRA_COMMENT")).toEqual([]);
    expect(timingKeys("WORKTREE_INSPECT_GIT")).toEqual([]);
    expect(timingKeys("WORKTREE_SET_AUTO_SYNC")).toEqual([
      "cadenceSeconds",
      "timeoutSeconds",
    ]);
    expect(timingKeys("WORKTREE_SET_AUTO_MERGE")).toEqual([]);
    expect(timingKeys("CCUSAGE_COLLECT")).toEqual([]);
    expect(timingKeys("MODEL_COST_REFRESH")).toEqual([]);
    expect(timingKeys("GITHUB_DISPATCH_WORKFLOW")).toEqual([]);
    expect(timingKeys("CONTROL_DELAY")).toEqual([]);
  });

  test("describes wait timing as optional, so no step requires it", () => {
    const fields = getConfigDescriptor("BUILD_START", "step")?.fields.filter(
      ({ key }) => ["cadenceSeconds", "timeoutSeconds"].includes(key),
    );

    expect(fields).toHaveLength(2);
    for (const field of fields ?? []) {
      expect(field.required).toBeUndefined();
      expect(field.control).toBe("number");
      expect(field.help).toBeTruthy();
    }
  });
});
