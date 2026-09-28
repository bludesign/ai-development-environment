import type { ResourceKind } from "@/lib/workflows/config-descriptor-types";
import { getConfigDescriptor } from "@/lib/workflows/config-descriptors";
import {
  WORKFLOW_STEP_KINDS,
  type WorkflowStepKind,
} from "@/lib/workflows/kinds";

import type { TransferReference } from "./package";

export type StaticReference = {
  kind: string;
  id: string;
  path: (string | number)[];
};

type Path = (string | number)[];
type Rule = { path: string[]; kind: string };

// Provider issue keys, user IDs, PR numbers and workflow-run IDs retain their
// meaning across installations. They must not be mistaken for local IDs merely
// because the editor presents them in a resource picker.
const resourceKinds: Partial<Record<ResourceKind, string>> = {
  agent: "AGENT",
  codebase: "CODEBASE",
  worktree: "WORKTREE",
  githubRepository: "GITHUB_REPOSITORY",
  apnsChannel: "APNS_CHANNEL",
  apnsRegistration: "APNS_REGISTRATION",
  skillGroup: "SKILL_GROUP_RESOURCE",
  mcpServer: "MCP_SERVER",
  iosConfiguration: "BUILD_CONFIGURATION",
  buildScript: "BUILD_SCRIPT",
  savedCommand: "COMMAND",
  agentRun: "RUN",
};

const fields: Partial<Record<WorkflowStepKind, Record<string, string>>> = {
  BUILD_START: { configurationId: "BUILD_CONFIGURATION" },
  CONTROL_SUBWORKFLOW: { versionId: "WORKFLOW_VERSION" },
  WORKTREE_SET_AUTO_SYNC: { conflictWorkflowId: "WORKFLOW" },
  WORKTREE_INSPECT_DIFF: { worktreeId: "WORKTREE" },
  WORKTREE_UPDATE_METADATA: { worktreeId: "WORKTREE" },
  WORKTREE_MOVE_CONTROL: { moveId: "WORKTREE_MOVE" },
  GITHUB_CANCEL_WORKFLOW_RUN: { codebaseRepositoryId: "REPOSITORY" },
  GITHUB_WAIT_CHECKS: { repositoryId: "GITHUB_REPOSITORY" },
  // workflowId here is a GitHub Actions ID, not an AIDE workflow definition.
  GITHUB_DISPATCH_WORKFLOW: { repositoryId: "GITHUB_REPOSITORY" },
  BUILD_READ_TEST_RESULTS: { buildId: "BUILD" },
  BUILD_READ_COVERAGE: { buildId: "BUILD" },
  BUILD_EXPORT: { buildId: "BUILD" },
  BUILD_DEPLOY: { buildId: "BUILD" },
  BUILD_CANCEL: { buildId: "BUILD" },
  BUILD_REBUILD: { buildId: "BUILD" },
  BUILD_GENERATE_REPORT: { buildId: "BUILD" },
  BUILD_DELETE: { buildIds: "BUILD" },
  COMMAND_RERUN: { commandRunId: "COMMAND_RUN" },
  COMMAND_TERMINATE: { commandRunId: "COMMAND_RUN" },
  COMMAND_READ_OUTPUT: { commandRunId: "COMMAND_RUN" },
  SKILL_PREPARE_SYNC: { groupId: "SKILL_GROUP_RESOURCE" },
  SKILL_RESOLVE_SYNC: { runId: "SKILL_RUN", itemId: "SKILL_SYNC_ITEM" },
  SKILL_SKIP_SYNC: { runId: "SKILL_RUN" },
  BUILD_DATA_DELETE: {
    collectionId: "BUILD_DATA_COLLECTION",
    entryIds: "BUILD_DATA_ENTRY",
  },
  BUILD_DATA_SET_LOCK: {
    collectionId: "BUILD_DATA_COLLECTION",
    entryId: "BUILD_DATA_ENTRY",
  },
  TAILSCALE_SERVE_UPSERT_TEMPLATE: { templateId: "TAILSCALE_TEMPLATE" },
  TAILSCALE_SERVE_SET_AGENT_ENABLED: { templateId: "TAILSCALE_TEMPLATE" },
  TAILSCALE_SERVE_DELETE_TEMPLATE: { templateId: "TAILSCALE_TEMPLATE" },
  IOS_DEVICE_REGISTER: { deviceId: "IOS_DEVICE" },
  IOS_DEVICE_REJECT: { deviceId: "IOS_DEVICE" },
  RUN_PLAY_PLAN: { runId: "RUN" },
  RUN_FOLLOW_UP: { runId: "RUN" },
  RUN_STEER: { runId: "RUN" },
  RUN_ANSWER: { batchId: "RUN_QUESTION_BATCH" },
  RUN_PAUSE: { runId: "RUN" },
  RUN_CONTINUE: { runId: "RUN" },
  RUN_CANCEL: { runId: "RUN" },
  RUN_REVISE_ANSWER: { batchId: "RUN_QUESTION_BATCH" },
  RUN_READ_RESULT: { runId: "RUN" },
  RUN_CAPTURE_CHECKPOINT: { runId: "RUN" },
  RUN_ARCHIVE_DELETE: { runId: "RUN" },
  SSE_ENDPOINT_ACTION: { endpointId: "SSE_ENDPOINT" },
  SSE_MOCK_ACTION: { endpointId: "SSE_ENDPOINT" },
  SSE_BREAKPOINT_RESOLVE: {
    breakpointId: "SSE_BREAKPOINT",
    mockCompositionId: "SSE_COMPOSITION",
  },
  SSE_HISTORY_CLEAR: { endpointId: "SSE_ENDPOINT", ids: "SSE_REQUEST" },
};

const nestedFields: Partial<Record<WorkflowStepKind, Rule[]>> = {
  BUILD_START: [
    { path: ["advancedSettings", "priorBuildForTestingId"], kind: "BUILD" },
  ],
  GITHUB_SAVE_AUTO_RETRY: [
    { path: ["input", "id"], kind: "AUTO_RETRY" },
    { path: ["input", "codebaseRepositoryId"], kind: "REPOSITORY" },
    { path: ["input", "repositoryGithubId"], kind: "GITHUB_REPOSITORY" },
    { path: ["input", "worktreeId"], kind: "WORKTREE" },
  ],
  GITLAB_SAVE_AUTO_RETRY: [
    { path: ["input", "id"], kind: "GITLAB_AUTO_RETRY" },
  ],
  TERMINAL_RUN: [
    { path: ["credentials", "*", "credential", "id"], kind: "CREDENTIAL" },
  ],
};

const filterKinds: Record<string, string> = {
  "repo.id": "REPOSITORY",
  "repo.githubId": "GITHUB_REPOSITORY",
  "pr.repositoryGithubId": "GITHUB_REPOSITORY",
  "codebase.repositoryId": "REPOSITORY",
  "codebase.id": "CODEBASE",
  "codebase.agentId": "AGENT",
  "agent.id": "AGENT",
  "worktree.id": "WORKTREE",
  "workflow.id": "WORKFLOW",
  "workflow.runId": "WORKFLOW_RUN",
  "build.id": "BUILD",
  "build.configurationId": "BUILD_CONFIGURATION",
  "command.id": "COMMAND_RUN",
  "command.commandId": "COMMAND",
  "run.id": "RUN",
  "skill.groupId": "SKILL_GROUP_RESOURCE",
  "skill.id": "SKILL",
  "skillSync.id": "SKILL_RUN",
  "buildData.id": "BUILD_DATA_COLLECTION",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function literal(
  value: unknown,
  path: Path,
  kind: string,
  output: StaticReference[],
  wrapped = false,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      literal(entry, [...path, index], kind, output, wrapped),
    );
    return;
  }
  const object = record(value);
  if (object) {
    if (!wrapped && object.source === "LITERAL")
      literal(object.value, [...path, "value"], kind, output, true);
    return;
  }
  if (
    typeof value === "string" &&
    value.trim() &&
    (wrapped || !value.includes("{{"))
  ) {
    output.push({ kind, id: value, path });
  }
}

/** Follow only declared paths; arbitrary script/JSON contents are never rewritten. */
function atPath(
  value: unknown,
  remaining: string[],
  path: Path,
  kind: string,
  output: StaticReference[],
  wrapped = false,
): void {
  const object = record(value);
  if (!wrapped && object?.source === "SESSION") return;
  if (!wrapped && object?.source === "LITERAL") {
    atPath(object.value, remaining, [...path, "value"], kind, output, true);
    return;
  }
  if (!remaining.length) {
    literal(value, path, kind, output, wrapped);
    return;
  }
  const [key, ...rest] = remaining;
  if (key === "*") {
    if (Array.isArray(value))
      value.forEach((entry, index) =>
        atPath(entry, rest, [...path, index], kind, output, wrapped),
      );
  } else if (object && key && Object.hasOwn(object, key)) {
    atPath(object[key], rest, [...path, key], kind, output, wrapped);
  }
}

const knownStepKinds = new Set<string>(WORKFLOW_STEP_KINDS);

/** Registered local references only; graph IDs, provider IDs and expressions retain their meaning. */
export function workflowReferences(
  definition: Record<string, unknown>,
  prefix: Path,
): StaticReference[] {
  const output: StaticReference[] = [];
  for (const collection of ["nodes", "triggers"] as const) {
    const nodes = definition[collection];
    if (!Array.isArray(nodes)) continue;
    nodes.forEach((raw, index) => {
      const node = record(raw);
      const config = record(node?.config);
      if (!node || typeof node.kind !== "string" || !config) return;
      const base = [...prefix, collection, index, "config"];
      const descriptor = getConfigDescriptor(
        node.kind,
        collection === "triggers" ? "trigger" : "step",
      );
      if (collection === "nodes") {
        const kind = node.kind as WorkflowStepKind;
        const fieldKinds = { ...fields[kind] };
        for (const field of descriptor?.fields ?? []) {
          if (field.options?.kind !== "resource") continue;
          const referenceKind = resourceKinds[field.options.resource];
          if (referenceKind) fieldKinds[field.key] = referenceKind;
        }
        if (knownStepKinds.has(kind)) {
          for (const key of [
            "agentId",
            "agentIds",
            "sourceAgentId",
            "targetAgentIds",
          ]) {
            if (Object.hasOwn(config, key)) fieldKinds[key] = "AGENT";
          }
        }
        if (kind === "SAVED_COMMAND" || kind === "CUSTOM_COMMAND") {
          // Stale fixed-target values do not affect CONTEXT execution.
          if (
            config.targetMode === "CONTEXT" ||
            config.targetMode === undefined
          ) {
            delete fieldKinds.agentId;
            delete fieldKinds.worktreeId;
          } else {
            if (config.targetMode !== "FIXED_WORKTREE")
              fieldKinds.agentId = "AGENT";
            else delete fieldKinds.agentId;
            if (config.targetMode !== "FIXED_AGENT")
              fieldKinds.worktreeId = "WORKTREE";
          }
        }
        if (kind.startsWith("RUN_")) {
          fieldKinds.mcpPresetIds = "MCP_PRESET";
          fieldKinds.attachmentIds = "RUN_ATTACHMENT";
        }
        if (kind === "SSE_MOCK_ACTION") {
          if (
            ["SAVE_TEMPLATE", "DELETE_TEMPLATE"].includes(
              String(config.operation),
            )
          )
            fieldKinds.resourceId = "SSE_TEMPLATE";
          else if (
            [
              "SAVE_COMPOSITION",
              "ACTIVATE_COMPOSITION",
              "DELETE_COMPOSITION",
            ].includes(String(config.operation))
          )
            fieldKinds.resourceId = "SSE_COMPOSITION";
        }
        for (const [key, referenceKind] of Object.entries(fieldKinds))
          atPath(config, [key], base, referenceKind, output);
        for (const rule of nestedFields[kind] ?? [])
          atPath(config, rule.path, base, rule.kind, output);
      }
      // Trigger filters are exact expected values, not runtime-resolved bindings.
      // Only known session paths identify local resources; e.g. repo.id and
      // repo.githubId intentionally have different resource kinds.
      if (collection === "triggers") {
        const filters = record(config.filters);
        if (filters)
          for (const [key, referenceKind] of Object.entries(filterKinds)) {
            literal(
              filters[key],
              [...base, "filters", key],
              referenceKind,
              output,
              true,
            );
          }
        if (filters && node.kind.startsWith("AGENT_")) {
          literal(
            filters["job.id"],
            [...base, "filters", "job.id"],
            "AGENT_JOB",
            output,
            true,
          );
        }
      }
    });
  }
  return [
    ...new Map(
      output.map((reference) => [JSON.stringify(reference.path), reference]),
    ).values(),
  ];
}

export function referenceKey(entityKey: string, path: Path): string {
  return `${entityKey}/ref/${path.map(String).map(encodeURIComponent).join("/")}`;
}

export function reference(
  kind: string,
  _id: string,
  path: Path,
  entityKey: string,
  identity: Record<string, unknown>,
  label: string,
  targetEntityKey?: string,
): TransferReference {
  return {
    key: referenceKey(entityKey, path),
    kind,
    path,
    identity,
    label,
    entityKey: targetEntityKey,
  };
}
