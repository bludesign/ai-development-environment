import { BUILD_ACTIONS } from "@ai-development-environment/agent-contract/builds";
import { CODEBASE_GIT_OPERATIONS } from "@ai-development-environment/agent-contract/codebases";
import {
  WORKTREE_GIT_OPERATIONS,
  WORKTREE_OPERATIONS,
  WORKTREE_PREPARATION_ACTIONS,
} from "@ai-development-environment/agent-contract/worktrees";

import type {
  ConfigFieldDescriptor,
  ConfigFieldScope,
  ConfigOptionSource,
  ConfigStaticOption,
  KindConfigDescriptor,
  ResourceKind,
  StepConfigDescriptors,
  TriggerConfigDescriptors,
} from "./config-descriptor-types";
import {
  WORKFLOW_RESOURCE_KINDS,
  type WorkflowStepKind,
  type WorkflowTriggerKind,
} from "./kinds";
import { workflowValueSessionPaths } from "./session";

/**
 * The config every step and trigger kind accepts, described declaratively.
 *
 * This is the single source of truth for three consumers: the editor's config
 * form (`components/workflows/config-fields/config-fields-editor.tsx`), the
 * JSON Schema published in the workflow catalog (`config-schema.ts`), and
 * through that catalog the MCP tools that let an agent author workflows. A key
 * missing here is invisible to the schema and falls back to the editor's
 * raw-JSON escape hatch, so new adapter config belongs in this file too.
 */

// ---------------------------------------------------------------------------
// Field builders — keep the descriptor maps below terse and readable.
// ---------------------------------------------------------------------------

type FieldOptions = Partial<
  Omit<ConfigFieldDescriptor, "key" | "label" | "control">
>;

function humanize(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");
}

function staticOptions(
  values: readonly string[],
): Extract<ConfigOptionSource, { kind: "static" }> {
  return {
    kind: "static",
    options: values.map((value) => ({ value, label: humanize(value) })),
  };
}

function listOptions(
  options: readonly ConfigStaticOption[],
): Extract<ConfigOptionSource, { kind: "static" }> {
  return { kind: "static", options };
}

const RESOURCE_SESSION_PATHS: Partial<Record<ResourceKind, string>> = {
  agent: "agent.id",
  codebase: "codebase.id",
  worktree: "worktree.id",
  githubRepository: "repo.id",
  githubPullRequest: "pr.number",
  jiraTicket: "ticket.key",
  agentRun: "run.id",
  githubWorkflowRun: "pipeline.runId",
};

function resourceOptions(
  resource: ResourceKind,
  scopeFrom?: string,
): Extract<ConfigOptionSource, { kind: "resource" }> {
  return {
    kind: "resource",
    resource,
    scopeFrom,
    sessionPath: RESOURCE_SESSION_PATHS[resource],
  };
}

/**
 * A scalar string the author may pin, bind to a session path, or write with
 * `{{path}}` tokens the runtime substitutes.
 */
const SCALAR_MODES = ["literal", "session", "interpolation"] as const;

/**
 * A composite value — a list, a record, a condition tree, a raw JSON blob. There
 * is no single scalar to bind, but `resolveWorkflowValue` walks the whole config
 * before a step runs, so every string *inside* one of these still interpolates.
 */
const NESTED_MODES = ["literal", "interpolation"] as const;

const text = (
  key: string,
  label: string,
  options: FieldOptions = {},
): ConfigFieldDescriptor => ({
  key,
  label,
  control: "text",
  valueModes: SCALAR_MODES,
  ...options,
});

const multiline = (
  key: string,
  label: string,
  options: FieldOptions = {},
): ConfigFieldDescriptor => text(key, label, { multiline: true, ...options });

const num = (
  key: string,
  label: string,
  options: FieldOptions = {},
): ConfigFieldDescriptor => ({
  key,
  label,
  control: "number",
  valueModes: ["literal", "session"],
  ...options,
});

const bool = (
  key: string,
  label: string,
  options: FieldOptions = {},
): ConfigFieldDescriptor => ({
  key,
  label,
  control: "boolean",
  ...options,
});

const enumField = (
  key: string,
  label: string,
  source: ConfigOptionSource,
  options: FieldOptions = {},
): ConfigFieldDescriptor => ({
  key,
  label,
  control: "enum",
  options: source,
  ...options,
});

const resource = (
  key: string,
  label: string,
  kind: ResourceKind,
  options: FieldOptions & { scopeFrom?: string } = {},
): ConfigFieldDescriptor => {
  const { scopeFrom, ...rest } = options;
  return {
    key,
    label,
    control: "resource",
    options: resourceOptions(kind, scopeFrom),
    // The picker accepts a typed-in value, so an id assembled from session data
    // is as valid here as one chosen from the list.
    valueModes: SCALAR_MODES,
    ...rest,
  };
};

const resourceMulti = (
  key: string,
  label: string,
  kind: ResourceKind,
  options: FieldOptions & { scopeFrom?: string } = {},
): ConfigFieldDescriptor => {
  const { scopeFrom, ...rest } = options;
  return {
    key,
    label,
    control: "resourceMulti",
    options: resourceOptions(kind, scopeFrom),
    valueModes: NESTED_MODES,
    ...rest,
  };
};

const stringList = (
  key: string,
  label: string,
  options: FieldOptions = {},
): ConfigFieldDescriptor => ({
  key,
  label,
  control: "stringList",
  valueModes: NESTED_MODES,
  ...options,
});

const mcpPresets = (
  kind: "PLAN" | "SESSION" | null,
): ConfigFieldDescriptor => ({
  key: "mcpPresetIds",
  label: "MCP tool presets",
  control: "mcpPresetMulti",
  presetKind: kind,
  default: [],
});

const record = (
  key: string,
  label: string,
  options: FieldOptions = {},
): ConfigFieldDescriptor => ({
  key,
  label,
  control: "record",
  valueModes: NESTED_MODES,
  ...options,
});

const json = (
  key: string,
  label: string,
  options: FieldOptions = {},
): ConfigFieldDescriptor => ({
  key,
  label,
  control: "json",
  valueModes: NESTED_MODES,
  ...options,
});

const condition = (
  key: string,
  label: string,
  options: FieldOptions = {},
): ConfigFieldDescriptor => ({
  key,
  label,
  control: "condition",
  valueModes: NESTED_MODES,
  ...options,
});

const choiceOptions = (
  key: string,
  label: string,
  options: FieldOptions = {},
): ConfigFieldDescriptor => ({
  key,
  label,
  control: "choiceOptions",
  valueModes: NESTED_MODES,
  ...options,
});

const triggerChoices = (
  key: string,
  label: string,
  options: FieldOptions = {},
): ConfigFieldDescriptor => ({
  key,
  label,
  control: "triggerChoices",
  ...options,
});

// ---------------------------------------------------------------------------
// Shared option sets and reused field groups.
// ---------------------------------------------------------------------------

const OPERATOR_OPTIONS = listOptions([
  { value: "EQ", label: "Equals" },
  { value: "NE", label: "Not equal" },
  { value: "GT", label: "Greater than" },
  { value: "GTE", label: "Greater or equal" },
  { value: "LT", label: "Less than" },
  { value: "LTE", label: "Less or equal" },
  { value: "CONTAINS", label: "Contains" },
  { value: "MATCHES", label: "Matches RE2" },
  { value: "EXISTS", label: "Exists" },
]);

const WORKTREE_OPERATION_OPTIONS = staticOptions(
  WORKTREE_OPERATIONS.filter((operation) => operation !== "OPEN_EDITOR"),
);

const githubCoordinateFields = (): ConfigFieldDescriptor[] => [
  text("owner", "Repository owner", {
    placeholder: "octocat",
    help: "Defaults to the repository from session data.",
  }),
  text("name", "Repository name", { placeholder: "hello-world" }),
];

/**
 * Provider, model, and effort are one decision, so they are one control: the
 * catalog-driven picker from the start-session page in literal mode, or session
 * bindings for all three in variable mode. The catalog scopes to `worktreeId`
 * when that sibling is a literal. `key` is the primary `model` slot; `modelKeys`
 * names all three so none leaks into the raw-JSON escape hatch.
 */
const modelField = (): ConfigFieldDescriptor => ({
  key: "model",
  label: "Model",
  control: "model",
  required: true,
  valueModes: ["literal", "session"],
  modelKeys: {
    provider: "provider",
    model: "model",
    effort: "effort",
    scopeFrom: "worktreeId",
  },
});

const runInputFields = (
  kind: "PLAN" | "SESSION" | null,
): ConfigFieldDescriptor[] => [
  resource("worktreeId", "Worktree", "worktree"),
  resource("jiraIssueKey", "Jira issue key", "jiraTicket", {
    placeholder: "APP-123",
  }),
  modelField(),
  bool("webSearchEnabled", "Enable web search"),
  mcpPresets(kind),
  num("worktreeConcurrencyLimit", "Worktree concurrency limit", {
    default: kind === "PLAN" ? 0 : kind === "SESSION" ? 1 : undefined,
    minimum: 0,
    maximum: 32,
    integer: true,
    help:
      kind === "PLAN"
        ? "Maximum plans admitted on this worktree. Use 0 for unlimited."
        : kind === "SESSION"
          ? "Maximum sessions admitted on this worktree. Use 0 for unlimited."
          : "Maximum same-kind runs admitted on this worktree. Use 0 for unlimited; leave empty for the source kind's default.",
  }),
  multiline("prompt", "Prompt", { required: true }),
  stringList("attachmentIds", "Attachment IDs"),
];

// ---------------------------------------------------------------------------
// Step descriptors — authored from src/services/workflows/register-adapters.ts
// and src/services/workflows/workflows.service.ts.
// ---------------------------------------------------------------------------

const STEP_CONFIG_DESCRIPTORS: StepConfigDescriptors = {
  // -- Jira ------------------------------------------------------------------
  JIRA_LOAD_TICKET: {
    fields: [
      resource("issueKey", "Issue key", "jiraTicket", {
        placeholder: "APP-123",
      }),
      bool("force", "Bypass cache"),
    ],
  },
  JIRA_TRANSITION: {
    fields: [
      resource("issueKey", "Issue key", "jiraTicket", {
        placeholder: "APP-123",
      }),
      text("transitionId", "Transition ID", { required: true }),
    ],
  },
  JIRA_COMMENT: {
    fields: [
      resource("issueKey", "Issue key", "jiraTicket", {
        placeholder: "APP-123",
      }),
      multiline("content", "Comment", { required: true }),
      enumField(
        "format",
        "Format",
        listOptions([
          { value: "MARKDOWN", label: "Markdown" },
          { value: "JIRA_WIKI", label: "Jira wiki" },
        ]),
      ),
    ],
  },
  JIRA_ASSIGN: {
    fields: [
      resource("issueKey", "Issue key", "jiraTicket", {
        placeholder: "APP-123",
      }),
      resource("accountId", "Assignee", "jiraUser", {
        scopeFrom: "issueKey",
        help: "Leave empty to unassign the ticket.",
      }),
    ],
  },
  JIRA_UPDATE_FIELDS: {
    fields: [
      resource("issueKey", "Issue key", "jiraTicket", {
        placeholder: "APP-123",
      }),
      json("fields", "Fields", {
        placeholder: '{ "labels": ["ready"] }',
      }),
    ],
  },
  JIRA_RESOLVE_BRANCH: {
    fields: [
      resource("issueKey", "Issue key", "jiraTicket", {
        placeholder: "APP-123",
      }),
      resource("codebaseId", "Codebase", "codebase"),
    ],
  },
  // -- GitHub ----------------------------------------------------------------
  GITHUB_LOAD_PR: {
    fields: [...githubCoordinateFields(), num("number", "Pull request number")],
  },
  GITHUB_MERGE_PR: {
    fields: [
      ...githubCoordinateFields(),
      num("number", "Pull request number"),
      enumField(
        "method",
        "Merge method",
        listOptions([
          { value: "SQUASH", label: "Squash" },
          { value: "MERGE", label: "Merge" },
          { value: "REBASE", label: "Rebase" },
        ]),
      ),
      text("commitHeadline", "Commit headline"),
      multiline("commitBody", "Commit body"),
      text("authorEmail", "Author email"),
    ],
  },
  GITHUB_COLLECT_REVIEW_THREADS: {
    fields: [...githubCoordinateFields(), num("number", "Pull request number")],
  },
  GITHUB_REPLY_REVIEW_THREAD: {
    fields: [
      text("threadId", "Review thread ID", { required: true }),
      multiline("body", "Reply", { required: true }),
    ],
  },
  GITHUB_SET_REVIEW_THREAD_RESOLVED: {
    fields: [
      text("threadId", "Review thread ID", { required: true }),
      bool("resolved", "Mark resolved"),
    ],
  },
  GITHUB_CREATE_PR: {
    fields: [
      ...githubCoordinateFields(),
      text("baseRefName", "Base branch"),
      text("headRefName", "Head branch"),
      text("title", "Title"),
      multiline("body", "Body"),
      bool("draft", "Open as draft"),
    ],
  },
  GITHUB_SET_PR_LABELS: {
    fields: [
      ...githubCoordinateFields(),
      num("number", "Pull request number"),
      stringList("labels", "Labels"),
    ],
  },
  GITHUB_RETRY_PIPELINE: {
    fields: [
      resource("repositoryId", "Repository", "githubRepository"),
      text("checkSuiteId", "Check suite ID"),
    ],
  },
  GITHUB_RETRY_JOB: {
    fields: [
      resource("repositoryId", "Repository", "githubRepository"),
      text("checkSuiteId", "Check suite ID", { required: true }),
      text("jobId", "Workflow job ID", { required: true }),
    ],
  },
  GITHUB_CANCEL_WORKFLOW_RUN: {
    fields: [
      text("codebaseRepositoryId", "Codebase repository ID"),
      resource("workflowRunId", "Workflow run", "githubWorkflowRun", {
        scopeFrom: "codebaseRepositoryId",
      }),
      bool("force", "Force cancel"),
    ],
  },
  GITHUB_SAVE_AUTO_RETRY: {
    fields: [json("input", "Auto-retry rule", { required: true })],
  },
  GITHUB_WAIT_CHECKS: {
    fields: [
      text("repositoryId", "Repository ID"),
      text("workflowRunId", "Workflow run ID"),
    ],
  },
  // -- GitLab ----------------------------------------------------------------
  GITLAB_LOAD_MR: {
    fields: [text("projectId", "Project ID"), num("iid", "Merge request IID")],
  },
  GITLAB_CREATE_MR: {
    fields: [
      text("projectId", "Project ID"),
      text("sourceBranch", "Source branch"),
      text("targetBranch", "Target branch"),
      text("title", "Title"),
      multiline("description", "Description"),
      bool("removeSourceBranch", "Remove source branch"),
      bool("squash", "Squash commits"),
      stringList("reviewerIds", "Reviewer IDs"),
      stringList("labels", "Labels"),
    ],
  },
  GITLAB_UPDATE_MR: {
    fields: [
      text("projectId", "Project ID"),
      num("iid", "Merge request IID"),
      text("title", "Title"),
      multiline("description", "Description"),
      enumField("stateEvent", "State", staticOptions(["CLOSE", "REOPEN"])),
      stringList("reviewerIds", "Reviewer IDs"),
      stringList("labels", "Labels"),
    ],
  },
  GITLAB_SUBMIT_REVIEW: {
    fields: [
      text("projectId", "Project ID"),
      num("iid", "Merge request IID"),
      enumField(
        "outcome",
        "Review outcome",
        staticOptions(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
      ),
      multiline("body", "Review body"),
    ],
  },
  GITLAB_REPLY_DISCUSSION: {
    fields: [
      text("projectId", "Project ID"),
      num("iid", "Merge request IID"),
      text("discussionId", "Discussion ID", { required: true }),
      multiline("body", "Reply", { required: true }),
    ],
  },
  GITLAB_SET_DISCUSSION_RESOLVED: {
    fields: [
      text("projectId", "Project ID"),
      num("iid", "Merge request IID"),
      text("discussionId", "Discussion ID", { required: true }),
      bool("resolved", "Mark resolved"),
    ],
  },
  GITLAB_MERGE_MR: {
    fields: [
      text("projectId", "Project ID"),
      num("iid", "Merge request IID"),
      bool("squash", "Squash commits"),
      bool("removeSourceBranch", "Remove source branch"),
      bool("autoMerge", "Enable auto-merge"),
      text("sha", "Expected source SHA"),
    ],
  },
  GITLAB_SET_MR_LABELS: {
    fields: [
      text("projectId", "Project ID"),
      num("iid", "Merge request IID"),
      stringList("labels", "Labels"),
    ],
  },
  GITLAB_REQUEST_REVIEWERS: {
    fields: [
      text("projectId", "Project ID"),
      num("iid", "Merge request IID"),
      stringList("reviewerIds", "Reviewer IDs"),
    ],
  },
  GITLAB_CREATE_PIPELINE: {
    fields: [
      text("projectId", "Project ID"),
      text("ref", "Git ref"),
      json("variables", "Pipeline variables"),
    ],
  },
  GITLAB_RETRY_PIPELINE: {
    fields: [
      text("projectId", "Project ID"),
      text("pipelineId", "Pipeline ID"),
    ],
  },
  GITLAB_RETRY_JOB: {
    fields: [text("projectId", "Project ID"), text("jobId", "Job ID")],
  },
  GITLAB_CANCEL_PIPELINE: {
    fields: [
      text("projectId", "Project ID"),
      text("pipelineId", "Pipeline ID"),
    ],
  },
  GITLAB_SAVE_AUTO_RETRY: {
    fields: [json("input", "Auto-retry rule", { required: true })],
  },
  GITLAB_WAIT_PIPELINE: {
    fields: [
      text("projectId", "Project ID"),
      text("pipelineId", "Pipeline ID"),
    ],
  },
  // -- Worktrees -------------------------------------------------------------
  WORKTREE_CREATE: {
    fields: [
      resource("codebaseId", "Codebase", "codebase"),
      enumField(
        "mode",
        "Branch mode",
        staticOptions(["NEW", "EXISTING", "TICKET"]),
      ),
      text("branchName", "Branch name"),
      text("ticketKey", "Ticket key", { placeholder: "APP-123" }),
      text("baseBranch", "Base branch"),
    ],
  },
  WORKTREE_CHANGE_BRANCH: {
    fields: [
      resource("worktreeId", "Worktree", "worktree"),
      enumField(
        "mode",
        "Branch mode",
        staticOptions(["NEW", "EXISTING", "TICKET"]),
      ),
      text("branchName", "Branch name"),
      text("ticketKey", "Ticket key", { placeholder: "APP-123" }),
      text("baseBranch", "Base branch"),
      bool("stashOnFailure", "Stash on failure"),
    ],
  },
  WORKTREE_COMMIT: {
    fields: [
      resource("worktreeId", "Worktree", "worktree"),
      multiline("message", "Commit message", { required: true }),
      bool("signed", "Signed commit"),
      bool("stageAll", "Stage all", { default: true }),
      json("paths", "Selected paths"),
    ],
  },
  WORKTREE_REFRESH_PULL_REQUEST: {
    fields: [resource("worktreeId", "Worktree", "worktree")],
  },
  WORKTREE_OPERATION: {
    fields: [
      resource("worktreeId", "Worktree", "worktree"),
      enumField("operation", "Operation", WORKTREE_OPERATION_OPTIONS),
      bool("forcePreparations", "Force preparation conflicts", {
        help: "Destructively resets preparation-managed paths before Sync or Rebase, then reapplies the current rules.",
      }),
    ],
  },
  WORKTREE_PREPARATION: {
    fields: [
      resource("worktreeId", "Worktree", "worktree"),
      enumField(
        "action",
        "Action",
        staticOptions(WORKTREE_PREPARATION_ACTIONS),
      ),
    ],
  },
  WORKTREE_SET_AUTO_SYNC: {
    fields: [
      resource("worktreeId", "Worktree", "worktree"),
      enumField(
        "action",
        "Action",
        staticOptions(["ENABLE", "RETRY", "FORCE", "CANCEL"]),
      ),
      text("conflictWorkflowId", "Conflict workflow ID"),
      text("conflictWorkflowChoice", "Conflict workflow choice"),
    ],
  },
  WORKTREE_SET_AUTO_MERGE: {
    fields: [
      resource("worktreeId", "Worktree", "worktree"),
      enumField(
        "action",
        "Action",
        staticOptions(["ENABLE", "RETRY", "CANCEL"]),
      ),
      text("repositoryNameWithOwner", "Repository", {
        placeholder: "owner/repository",
      }),
      num("pullRequestNumber", "Pull request number"),
      enumField(
        "method",
        "Merge method",
        staticOptions(["MERGE", "REBASE", "SQUASH"]),
      ),
      text("commitHeadline", "Commit headline"),
      multiline("commitBody", "Commit body"),
      text("authorEmail", "Author email"),
      bool("deleteWorktree", "Delete worktree after merge"),
      bool("moveTicketToDone", "Move Jira ticket to done"),
    ],
  },
  WORKTREE_DELETE: {
    fields: [
      resource("worktreeId", "Worktree", "worktree"),
      bool("deleteRemoteBranch", "Delete remote branch"),
    ],
  },
  WORKTREE_MOVE: {
    fields: [
      resource("worktreeId", "Source worktree", "worktree"),
      resource("targetCodebaseId", "Target codebase", "codebase", {
        required: true,
      }),
      resource("targetWorktreeId", "Target worktree", "worktree"),
      bool("deleteSource", "Delete source"),
    ],
  },
  WORKTREE_INSPECT: {
    fields: [resource("worktreeId", "Worktree", "worktree")],
  },
  WORKTREE_INSPECT_GIT: {
    fields: [resource("worktreeId", "Worktree", "worktree")],
  },
  WORKTREE_GIT_OPERATION: {
    fields: [
      resource("worktreeId", "Worktree", "worktree"),
      enumField(
        "operation",
        "Operation",
        staticOptions(WORKTREE_GIT_OPERATIONS),
      ),
      text("branch", "Branch"),
      text("stashOid", "Stash OID"),
      bool("stashChanges", "Stash changes first"),
    ],
  },
  WORKTREE_WAIT_PUSH_READY: {
    fields: [resource("worktreeId", "Worktree", "worktree")],
  },
  WORKTREE_SNAPSHOT: {
    fields: [text("kind", "Checkpoint kind", { placeholder: "STEP" })],
  },
  // -- Codebases -------------------------------------------------------------
  CODEBASE_FETCH_REFRESH: {
    fields: [
      resource("codebaseId", "Codebase", "codebase"),
      enumField("operation", "Operation", staticOptions(["FETCH", "REFRESH"])),
    ],
  },
  CODEBASE_INSPECT_GIT: {
    fields: [resource("codebaseId", "Codebase", "codebase")],
  },
  CODEBASE_GIT_OPERATION: {
    fields: [
      resource("codebaseId", "Codebase", "codebase"),
      enumField(
        "operation",
        "Operation",
        staticOptions(CODEBASE_GIT_OPERATIONS),
      ),
      text("branch", "Branch"),
      text("stashOid", "Stash OID"),
      bool("stashChanges", "Stash changes first"),
    ],
  },
  // -- Builds ----------------------------------------------------------------
  BUILD_START: {
    fields: [
      resource("worktreeId", "Worktree", "worktree"),
      text("configurationId", "Build configuration ID", { required: true }),
      enumField("action", "Action", staticOptions(BUILD_ACTIONS)),
      json("destination", "Destination"),
      resourceMulti("scriptIds", "Build scripts", "buildScript"),
      json("advancedSettings", "Advanced settings"),
      bool("exportWhenComplete", "Export when complete"),
      json("exportSettings", "Export settings"),
      bool("worktreeCoverage", "Collect worktree coverage"),
    ],
  },
  BUILD_READ_TEST_RESULTS: {
    fields: [text("buildId", "Build ID")],
  },
  BUILD_READ_COVERAGE: {
    fields: [text("buildId", "Build ID")],
  },
  BUILD_IMPORT_COVERAGE: {
    fields: [
      resource("worktreeId", "Worktree", "worktree"),
      text("buildName", "Build name", {
        default: "{{workflow.name}}",
        help: "Name shown on the build and coverage pages. Defaults to the workflow name.",
      }),
      text("reportPath", "Coverage file", {
        required: true,
        default: "coverage/lcov.info",
        help: "Path inside the worktree, written by whichever test command ran first.",
      }),
      enumField(
        "format",
        "Coverage format",
        staticOptions(["AUTO", "LCOV", "ISTANBUL"]),
      ),
    ],
  },
  BUILD_EXPORT: {
    fields: [
      text("buildId", "Build ID"),
      json("settings", "Export settings", { required: true }),
    ],
  },
  BUILD_DEPLOY: {
    fields: [text("buildId", "Build ID"), json("destinations", "Destinations")],
  },
  BUILD_CANCEL: {
    fields: [text("buildId", "Build ID")],
  },
  // -- Disk space -----------------------------------------------------------
  DISK_SPACE_LOAD: {
    fields: [resource("agentId", "Agent", "agent")],
  },
  DISK_SPACE_REFRESH: {
    fields: [resource("agentId", "Agent", "agent")],
  },
  DISK_SPACE_UPDATE_THRESHOLDS: {
    fields: [
      num("normalThresholdGiB", "Normal threshold (GiB)", {
        required: true,
      }),
      num("pressureThresholdGiB", "Pressure threshold (GiB)", {
        required: true,
      }),
    ],
  },
  DISK_SPACE_SET_MONITORING: {
    fields: [
      resource("agentId", "Agent", "agent"),
      bool("enabled", "Monitoring enabled", { required: true, default: true }),
    ],
  },
  DISK_SPACE_SET_PRESSURE_MODE: {
    fields: [
      resource("agentId", "Agent", "agent"),
      bool("enabled", "Manual pressure mode", {
        required: true,
        default: true,
      }),
    ],
  },
  // -- Skills / notifications / tools ---------------------------------------
  SKILL_APPLY: {
    fields: [
      resource("groupId", "Skill group", "skillGroup", {
        help: "Leave empty to sync all skills.",
      }),
    ],
  },
  NOTIFICATION_SEND: {
    fields: [
      text("title", "Title", { required: true }),
      multiline("body", "Body", { required: true }),
      text("href", "Link"),
    ],
  },
  IOS_PUSH_SEND: {
    fields: [
      enumField(
        "targetMode",
        "Target mode",
        staticOptions(["ALL", "DEVICES", "BROADCAST", "DIRECT"]),
      ),
      resourceMulti("registrationIds", "Registrations", "apnsRegistration"),
      resource("channelId", "Broadcast channel", "apnsChannel"),
      json("editor", "Notification editor"),
      text("directToken", "Direct device token"),
      enumField(
        "directTokenEncoding",
        "Token encoding",
        staticOptions(["HEX", "BASE64"]),
      ),
      enumField(
        "directEnvironment",
        "Environment",
        staticOptions(["SANDBOX", "PRODUCTION"]),
      ),
    ],
  },
  COMMAND_RERUN: {
    fields: [text("commandRunId", "Command run ID", { required: true })],
  },
  COMMAND_TERMINATE: {
    fields: [text("commandRunId", "Command run ID", { required: true })],
  },
  COMMAND_READ_OUTPUT: {
    fields: [
      text("commandRunId", "Command run ID", { required: true }),
      num("first", "Maximum chunks"),
    ],
  },
  WORKTREE_INSPECT_DIFF: {
    fields: [
      text("worktreeId", "Worktree ID"),
      text("scope", "Diff scope", { required: true }),
      text("path", "Path"),
      text("previousPath", "Previous path"),
      text("commitSha", "Commit SHA"),
    ],
  },
  WORKTREE_UPDATE_METADATA: {
    fields: [
      text("worktreeId", "Worktree ID"),
      text("baseBranch", "Base branch"),
      text("highlightColor", "Highlight color"),
    ],
  },
  WORKTREE_MOVE_CONTROL: {
    fields: [
      text("moveId", "Move ID", { required: true }),
      enumField(
        "operation",
        "Operation",
        staticOptions(["RETRY_WITH_STASH", "CANCEL"]),
      ),
    ],
  },
  BUILD_REBUILD: { fields: [text("buildId", "Build ID")] },
  BUILD_GENERATE_REPORT: {
    fields: [
      text("buildId", "Build ID"),
      enumField(
        "reportKind",
        "Report kind",
        staticOptions(["TEST_RESULTS", "CODE_COVERAGE"]),
      ),
    ],
  },
  BUILD_DELETE: { fields: [stringList("buildIds", "Build IDs")] },
  SKILL_PREPARE_SYNC: {
    fields: [
      enumField("syncKind", "Sync kind", staticOptions(["ALL", "GROUP"])),
      text("groupId", "Skill group ID"),
    ],
  },
  SKILL_RESOLVE_SYNC: {
    fields: [
      text("runId", "Sync run ID", { required: true }),
      text("itemId", "Conflict item ID", { required: true }),
      enumField(
        "resolution",
        "Resolution",
        staticOptions(["LOCAL", "REMOTE", "SKIP"]),
      ),
    ],
  },
  SKILL_SKIP_SYNC: {
    fields: [text("runId", "Sync run ID", { required: true })],
  },
  BUILD_DATA_REFRESH: { fields: [] },
  BUILD_DATA_DELETE: {
    fields: [
      text("collectionId", "Collection ID", { required: true }),
      stringList("entryIds", "Entry IDs"),
      bool("overrideProtection", "Override protection"),
    ],
  },
  BUILD_DATA_SET_LOCK: {
    fields: [
      text("collectionId", "Collection ID", { required: true }),
      text("entryId", "Entry ID", { required: true }),
      bool("locked", "Locked"),
    ],
  },
  TAILSCALE_SERVE_INSPECT: {
    fields: [resourceMulti("agentIds", "Agents", "agent")],
  },
  TAILSCALE_SERVE_UPSERT_TEMPLATE: {
    fields: [
      text("templateId", "Template ID"),
      num("expectedRevision", "Expected revision", {
        minimum: 1,
        integer: true,
      }),
      text("name", "Template name", { required: true }),
      enumField(
        "protocol",
        "Listener protocol",
        staticOptions(["HTTP", "HTTPS", "TCP", "TLS_TERMINATED_TCP"]),
        { required: true, default: "HTTPS" },
      ),
      num("listenPort", "Incoming port", {
        required: true,
        default: 443,
        minimum: 1,
        maximum: 65_535,
        integer: true,
      }),
      text("mountPath", "Mount path", { default: "/" }),
      enumField(
        "destinationProtocol",
        "Destination protocol",
        staticOptions(["HTTP", "HTTPS", "HTTPS_INSECURE", "TCP"]),
        { required: true, default: "HTTP" },
      ),
      num("destinationPort", "Destination port", {
        required: true,
        default: 3000,
        minimum: 1,
        maximum: 65_535,
        integer: true,
      }),
      text("destinationPath", "Destination path", { default: "" }),
      bool("funnel", "Public Funnel"),
      stringList("appCapabilities", "App capabilities"),
      enumField(
        "proxyProtocol",
        "PROXY protocol",
        staticOptions(["NONE", "V1", "V2"]),
        { required: true, default: "NONE" },
      ),
      resourceMulti("agentIds", "Enabled agents", "agent", {
        required: true,
      }),
    ],
  },
  TAILSCALE_SERVE_SET_AGENT_ENABLED: {
    fields: [
      text("templateId", "Template ID", { required: true }),
      resource("agentId", "Agent", "agent", { required: true }),
      bool("enabled", "Enabled"),
      num("expectedRevision", "Expected revision", { required: true }),
    ],
  },
  TAILSCALE_SERVE_DELETE_TEMPLATE: {
    fields: [
      text("templateId", "Template ID", { required: true }),
      num("expectedRevision", "Expected revision", { required: true }),
    ],
  },
  SIGNING_REFRESH: { fields: [stringList("agentIds", "Agent IDs")] },
  SIGNING_SYNC_PROFILE: {
    fields: [
      text("uuid", "Profile UUID", { required: true }),
      text("sourceAgentId", "Source agent ID", { required: true }),
      stringList("targetAgentIds", "Target agent IDs"),
    ],
  },
  SIGNING_DELETE_EXPIRED: { fields: [stringList("agentIds", "Agent IDs")] },
  IOS_DEVICE_REGISTER: {
    fields: [text("deviceId", "Device ID", { required: true })],
  },
  IOS_DEVICE_REJECT: {
    fields: [text("deviceId", "Device ID", { required: true })],
  },
  AGENT_RECONCILE: { fields: [stringList("agentIds", "Agent IDs")] },
  AGENT_UPDATE_CADENCE: {
    fields: [
      text("agentId", "Agent ID", { required: true }),
      json("settings", "Cadence settings"),
    ],
  },
  CCUSAGE_COLLECT: { fields: [] },
  MODEL_COST_REFRESH: { fields: [] },
  GITHUB_UPDATE_PR: {
    fields: [
      text("owner", "Owner", { required: true }),
      text("name", "Repository", { required: true }),
      num("number", "Pull request number", { required: true }),
      text("title", "Title"),
      multiline("body", "Body"),
      bool("draft", "Draft"),
    ],
  },
  GITHUB_SUBMIT_REVIEW: {
    fields: [
      text("owner", "Owner", { required: true }),
      text("name", "Repository", { required: true }),
      num("number", "Pull request number", { required: true }),
      enumField(
        "event",
        "Review event",
        staticOptions(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      ),
      multiline("body", "Body"),
    ],
  },
  GITHUB_REQUEST_REVIEWERS: {
    fields: [
      text("owner", "Owner", { required: true }),
      text("name", "Repository", { required: true }),
      num("number", "Pull request number", { required: true }),
      stringList("reviewers", "Reviewers"),
      stringList("teamReviewers", "Team reviewers"),
    ],
  },
  GITHUB_DISPATCH_WORKFLOW: {
    fields: [
      text("repositoryId", "Repository ID", { required: true }),
      text("workflowId", "Workflow ID", { required: true }),
      text("ref", "Git ref", { required: true }),
      record("inputs", "Workflow inputs"),
    ],
  },
  JIRA_CREATE_TICKET: {
    fields: [
      text("projectKey", "Project key", { required: true }),
      text("issueTypeId", "Issue type ID", { required: true }),
      text("summary", "Summary", { required: true }),
      multiline("description", "Description"),
      json("fields", "Additional fields"),
    ],
  },
  JIRA_ADD_WORKLOG: {
    fields: [
      text("issueKey", "Issue key"),
      num("timeSpentSeconds", "Time spent (seconds)", { required: true }),
      text("startedAt", "Started at"),
      multiline("comment", "Comment"),
    ],
  },
  JIRA_LINK_TICKETS: {
    fields: [
      text("inwardIssueKey", "Inward issue key", { required: true }),
      text("outwardIssueKey", "Outward issue key", { required: true }),
      text("linkType", "Link type", { required: true }),
    ],
  },
  MCP_CALL: {
    fields: [
      resource("groupId", "MCP server", "mcpServer", { required: true }),
      text("name", "Tool name", { required: true }),
      json("arguments", "Arguments"),
    ],
  },
  SSE_ENDPOINT_ACTION: {
    fields: [
      enumField(
        "operation",
        "Operation",
        staticOptions([
          "CREATE",
          "UPDATE",
          "SET_MODE",
          "ROTATE_TOKEN",
          "DELETE",
        ]),
        { required: true },
      ),
      text("endpointId", "Endpoint ID"),
      json("input", "Endpoint input"),
    ],
  },
  SSE_MOCK_ACTION: {
    fields: [
      enumField(
        "operation",
        "Operation",
        staticOptions([
          "SAVE_TEMPLATE",
          "DELETE_TEMPLATE",
          "SAVE_COMPOSITION",
          "ACTIVATE_COMPOSITION",
          "DELETE_COMPOSITION",
        ]),
        { required: true },
      ),
      text("endpointId", "Endpoint ID"),
      text("resourceId", "Template or composition ID"),
      json("input", "Mock input"),
    ],
  },
  SSE_STORAGE_ACTION: {
    fields: [
      enumField(
        "operation",
        "Operation",
        staticOptions(["SET", "COMPARE_AND_SET", "INCREMENT", "DELETE"]),
        { required: true },
      ),
      text("key", "Storage key", { required: true }),
      json("value", "JSON value"),
      num("expectedVersion", "Expected version"),
      num("delta", "Increment amount"),
    ],
  },
  SSE_BREAKPOINT_RESOLVE: {
    fields: [
      text("breakpointId", "Breakpoint ID", { required: true }),
      num("version", "Version", { required: true, integer: true }),
      enumField(
        "resolution",
        "Resolution",
        staticOptions(["FORWARD", "SAVED_MOCK", "AD_HOC"]),
        { required: true },
      ),
      text("mockCompositionId", "Mock composition ID"),
      json("adHocComposition", "Ad hoc composition"),
    ],
  },
  SSE_HISTORY_CLEAR: {
    fields: [
      text("endpointId", "Endpoint ID"),
      stringList("ids", "Request IDs"),
    ],
  },
  SSE_SCRIPT_TEST: {
    fields: [
      multiline("source", "JavaScript", { required: true }),
      json("context", "Script context"),
      num("timeoutMs", "Timeout (ms)", { integer: true }),
      num("memoryLimitMb", "Memory limit (MiB)", { integer: true }),
      num("fetchTimeoutMs", "Fetch timeout (ms)", { integer: true }),
    ],
  },
  // -- Plans and sessions ----------------------------------------------------
  RUN_CREATE_PLAN: { fields: runInputFields("PLAN") },
  RUN_CREATE_SESSION: { fields: runInputFields("SESSION") },
  RUN_PLAY_PLAN: {
    fields: [
      text("runId", "Plan run ID"),
      mcpPresets("SESSION"),
      num("worktreeConcurrencyLimit", "Worktree concurrency limit", {
        default: 1,
        minimum: 0,
        maximum: 32,
        integer: true,
        help: "Maximum sessions admitted on this worktree. Use 0 for unlimited.",
      }),
    ],
  },
  RUN_FOLLOW_UP: {
    fields: [
      text("runId", "Source run ID"),
      ...runInputFields(null),
      enumField(
        "followUpMode",
        "Follow-up mode",
        staticOptions(["RESUME", "FRESH", "RESEND"]),
      ),
      text("contextMode", "Context mode"),
    ],
  },
  RUN_STEER: {
    fields: [
      text("runId", "Run ID"),
      multiline("prompt", "Steering prompt", { required: true }),
      stringList("attachmentIds", "Attachment IDs"),
    ],
  },
  RUN_ANSWER: {
    fields: [
      text("batchId", "Question batch ID", { required: true }),
      json("answers", "Answers"),
    ],
  },
  RUN_PAUSE: {
    fields: [text("runId", "Run ID")],
  },
  RUN_CONTINUE: {
    fields: [text("runId", "Run ID")],
  },
  RUN_CANCEL: {
    fields: [text("runId", "Run ID")],
  },
  RUN_REVISE_ANSWER: {
    fields: [
      text("batchId", "Question batch ID", { required: true }),
      json("answers", "Answers"),
      bool("stash", "Stash before revision"),
      bool("rollback", "Roll back to the question"),
    ],
  },
  RUN_READ_RESULT: {
    fields: [text("runId", "Run ID")],
  },
  RUN_CAPTURE_CHECKPOINT: {
    fields: [text("runId", "Run ID")],
  },
  RUN_ARCHIVE_DELETE: {
    fields: [
      text("runId", "Run ID"),
      bool("delete", "Delete permanently"),
      bool("archived", "Archive"),
    ],
  },
  // -- Human loop ------------------------------------------------------------
  HUMAN_CONFIRM: {
    fields: [multiline("prompt", "Prompt")],
  },
  HUMAN_CHOICE: {
    fields: [
      multiline("prompt", "Prompt"),
      bool("multiSelect", "Allow multiple selections"),
      bool("allowCustom", "Allow a custom answer"),
      choiceOptions("options", "Buttons"),
    ],
  },
  // -- Control flow ----------------------------------------------------------
  CONTROL_IF: {
    fields: [condition("condition", "Condition", { required: true })],
  },
  CONTROL_JOIN: {
    fields: [
      enumField(
        "mode",
        "Join mode",
        listOptions([
          { value: "ALL", label: "All — wait for every branch" },
          { value: "ANY", label: "Any — continue on the first branch" },
        ]),
        {
          help:
            "All (default) waits until every incoming branch has finished before continuing. " +
            "Any continues as soon as the first incoming branch arrives, and the remaining " +
            "branches keep running on their own. Either way, branches that were skipped do not " +
            "block the join, and the join itself is skipped when no branch reaches it.",
        },
      ),
    ],
  },
  CONTROL_DELAY: {
    fields: [num("seconds", "Delay (seconds)", { required: true })],
  },
  CONTROL_WAIT_UNTIL: {
    fields: [json("condition", "Condition", { required: true })],
  },
  CONTROL_FOR_EACH: {
    fields: [
      text("listPath", "List session path", {
        placeholder: "pr.unresolvedThreads",
      }),
      json("items", "Inline items"),
      enumField(
        "errorMode",
        "Error handling",
        listOptions([
          { value: "FAIL_FAST", label: "Fail fast" },
          { value: "COLLECT_ERRORS", label: "Collect errors" },
        ]),
      ),
    ],
  },
  // Try/catch is expressed entirely in the graph — the step takes no config and
  // routes failures out of its `catch` handle — but it still needs an entry so
  // the catalog can publish an (empty) schema rather than an opaque object.
  CONTROL_TRY: { fields: [] },
  CONTROL_SET_VARIABLE: {
    fields: [
      text("path", "Output path", {
        required: true,
        placeholder: "flags.ready",
      }),
      json("value", "Value"),
      multiline("script", "Script"),
    ],
  },
  CONTROL_SUBWORKFLOW: {
    fields: [
      text("versionId", "Sub-workflow version ID", { required: true }),
      json("inputMapping", "Input mapping"),
    ],
  },
  // -- Extensibility ---------------------------------------------------------
  SAVED_COMMAND: {
    fields: [
      resource("commandId", "Saved command ID", "savedCommand", {
        required: true,
      }),
      enumField(
        "completionMode",
        "Completion",
        staticOptions(["WAIT_FOR_EXIT", "FIRE_AND_FORGET"]),
      ),
      enumField(
        "targetMode",
        "Target",
        staticOptions(["CONTEXT", "FIXED_AGENT", "FIXED_WORKTREE"]),
      ),
      text("agentId", "Fixed agent ID", {
        visibleWhen: { key: "targetMode", equals: "FIXED_AGENT" },
      }),
      text("worktreeId", "Fixed worktree ID", {
        visibleWhen: { key: "targetMode", equals: "FIXED_WORKTREE" },
      }),
      text("outputPattern", "Output match pattern (RE2)", {
        placeholder: "ready on port ([0-9]+)",
        help: "Optional case-sensitive regex. Requires Wait for exit and emits through the match connector while the command runs.",
        valueModes: ["literal"],
      }),
      enumField(
        "outputMatchMode",
        "Output match behavior",
        staticOptions(["ONCE", "EACH_MATCH"]),
        { default: "ONCE" },
      ),
    ],
  },
  CUSTOM_COMMAND: {
    fields: [
      multiline("script", "Script", { required: true }),
      enumField(
        "completionMode",
        "Completion",
        staticOptions(["WAIT_FOR_EXIT", "FIRE_AND_FORGET"]),
      ),
      enumField(
        "targetMode",
        "Target",
        staticOptions(["CONTEXT", "FIXED_AGENT", "FIXED_WORKTREE"]),
      ),
      text("agentId", "Fixed agent ID", {
        visibleWhen: { key: "targetMode", equals: "FIXED_AGENT" },
      }),
      text("worktreeId", "Fixed worktree ID", {
        visibleWhen: { key: "targetMode", equals: "FIXED_WORKTREE" },
      }),
      text("outputPattern", "Output match pattern (RE2)", {
        placeholder: "ready on port ([0-9]+)",
        help: "Optional case-sensitive regex. Requires Wait for exit and emits through the match connector while the command runs.",
        valueModes: ["literal"],
      }),
      enumField(
        "outputMatchMode",
        "Output match behavior",
        staticOptions(["ONCE", "EACH_MATCH"]),
        { default: "ONCE" },
      ),
    ],
  },
  TERMINAL_RUN: {
    fields: [
      multiline("script", "Script", { required: true }),
      enumField("interpreter", "Interpreter", staticOptions(["SHELL", "NODE"])),
      record("environment", "Environment variables"),
      json("credentials", "Credential environment", {
        help: "JSON array of { name, credential: { id, kind, ownerId } } entries.",
      }),
    ],
  },
};

// ---------------------------------------------------------------------------
// Wait timing. Every step that parks on external work accepts the same two
// keys, so they are declared once here rather than repeated per kind.
// ---------------------------------------------------------------------------

/**
 * The steps that park on polled work — an agent job, an agent run, a build, a
 * command, a sub-workflow, a checks run. Each honours both `timeoutSeconds` and
 * `cadenceSeconds`; see `lib/workflows/wait-timing.ts` for what the runtime does
 * with them.
 *
 * A step listed here but not waiting would advertise knobs that do nothing, and
 * one that waits but is missing would keep its timing locked in code — the
 * adapter's `wait:` result is the thing to check when adding a step.
 */
const POLLED_WAIT_STEP_KINDS: readonly WorkflowStepKind[] = [
  // Agent jobs
  "WORKTREE_CREATE",
  "WORKTREE_CHANGE_BRANCH",
  "WORKTREE_OPERATION",
  "WORKTREE_PREPARATION",
  "WORKTREE_SET_AUTO_SYNC",
  "WORKTREE_DELETE",
  "WORKTREE_GIT_OPERATION",
  "WORKTREE_MOVE",
  "WORKTREE_WAIT_PUSH_READY",
  "WORKTREE_SNAPSHOT",
  "CODEBASE_FETCH_REFRESH",
  "CODEBASE_GIT_OPERATION",
  "BUILD_START",
  "BUILD_IMPORT_COVERAGE",
  "BUILD_EXPORT",
  "BUILD_DEPLOY",
  "DISK_SPACE_REFRESH",
  "TERMINAL_RUN",
  // Agent runs
  "RUN_CREATE_PLAN",
  "RUN_CREATE_SESSION",
  "RUN_PLAY_PLAN",
  "RUN_FOLLOW_UP",
  "RUN_REVISE_ANSWER",
  // Commands, skills, checks
  "SAVED_COMMAND",
  "CUSTOM_COMMAND",
  "COMMAND_RERUN",
  "BUILD_REBUILD",
  "BUILD_DATA_REFRESH",
  "TAILSCALE_SERVE_INSPECT",
  "TAILSCALE_SERVE_UPSERT_TEMPLATE",
  "TAILSCALE_SERVE_SET_AGENT_ENABLED",
  "TAILSCALE_SERVE_DELETE_TEMPLATE",
  "SIGNING_REFRESH",
  "SIGNING_SYNC_PROFILE",
  "SIGNING_DELETE_EXPIRED",
  "SKILL_APPLY",
  "GITHUB_WAIT_CHECKS",
  "GITLAB_WAIT_PIPELINE",
  // Control flow
  "CONTROL_SUBWORKFLOW",
  "CONTROL_WAIT_UNTIL",
];

/**
 * Steps whose wait ends when a person answers rather than when a poll finds the
 * work done. A cadence would be meaningless — nothing is being checked — so
 * these take the timeout alone.
 */
const ANSWERED_WAIT_STEP_KINDS: readonly WorkflowStepKind[] = [
  "HUMAN_CONFIRM",
  "HUMAN_CHOICE",
];

const cadenceField = (): ConfigFieldDescriptor =>
  num("cadenceSeconds", "Poll cadence (seconds)", {
    help: "How often to check whether the work has finished. Leave empty for this step's default.",
  });

const waitTimeoutField = (): ConfigFieldDescriptor =>
  num("timeoutSeconds", "Timeout (seconds)", {
    help: "How long to keep waiting before the step fails. Leave empty to wait for as long as the work takes.",
  });

function addWaitFields(
  kinds: readonly WorkflowStepKind[],
  fields: () => ConfigFieldDescriptor[],
): void {
  for (const kind of kinds) {
    const descriptor = STEP_CONFIG_DESCRIPTORS[kind];
    if (!descriptor) continue;
    const described = new Set(descriptor.fields.map(({ key }) => key));
    descriptor.fields = [
      // Timing lands after the step's own config, and never displaces a key a
      // kind already describes itself.
      ...descriptor.fields,
      ...fields().filter(({ key }) => !described.has(key)),
    ];
  }
}

addWaitFields(POLLED_WAIT_STEP_KINDS, () => [
  cadenceField(),
  waitTimeoutField(),
]);
addWaitFields(ANSWERED_WAIT_STEP_KINDS, () => [waitTimeoutField()]);

// ---------------------------------------------------------------------------
// Trigger descriptors. Every trigger supports `filters` (path → expected value);
// threshold triggers add threshold fields; a few carry bespoke validators.
// ---------------------------------------------------------------------------

const filtersField = (): ConfigFieldDescriptor =>
  record("filters", "Filters", {
    help: "Match when each session path equals the given value.",
    recordValueType: "json",
  });

const thresholdFields = (): ConfigFieldDescriptor[] => [
  text("thresholdPath", "Threshold path", {
    placeholder: "build.testSummary.failed",
  }),
  enumField("thresholdOperator", "Operator", OPERATOR_OPTIONS),
  json("thresholdValue", "Threshold value"),
];

function triggerWithFilters(
  extra: ConfigFieldDescriptor[] = [],
): KindConfigDescriptor {
  return { fields: [...extra, filtersField()] };
}

const THRESHOLD_TRIGGERS: WorkflowTriggerKind[] = [
  "BUILD_TEST_THRESHOLD",
  "BUILD_COVERAGE_THRESHOLD",
  "AGENT_DISK_THRESHOLD",
  "CCUSAGE_THRESHOLD",
  "RUN_USAGE_THRESHOLD",
  "BUILD_DATA_THRESHOLD",
  "AGENT_RESOURCE_THRESHOLD",
  "SIGNING_ASSET_EXPIRING",
];

const ALL_TRIGGER_KINDS: WorkflowTriggerKind[] = [
  "MANUAL",
  "MANUAL_CHOICE",
  "RESOURCE_MANUAL",
  "RESOURCE_MANUAL_CHOICE",
  "SCHEDULE",
  "WORKFLOW_FINISHED",
  "GITHUB_PR_STATE",
  "GITHUB_REVIEW_CHANGES_REQUESTED",
  "GITHUB_REVIEW_COMMENT",
  "GITHUB_PR_CLOSED",
  "GITHUB_CHECK_FAILED",
  "GITHUB_PUSH_DEFAULT",
  "GITHUB_WORKFLOW_SUCCEEDED",
  "GITHUB_ISSUE_COMMAND",
  "GITHUB_ACTIONS_RESULT",
  "GITHUB_PR_LABEL",
  "GITLAB_MR_STATE",
  "GITLAB_REVIEW_CHANGES_REQUESTED",
  "GITLAB_REVIEW_COMMENT",
  "GITLAB_MR_CLOSED",
  "GITLAB_PIPELINE_FAILED",
  "GITLAB_PUSH_DEFAULT",
  "GITLAB_PIPELINE_SUCCEEDED",
  "GITLAB_NOTE_COMMAND",
  "GITLAB_PIPELINE_RESULT",
  "GITLAB_MR_LABEL",
  "BUILD_RESULT",
  "BUILD_TEST_THRESHOLD",
  "BUILD_COVERAGE_THRESHOLD",
  "BUILD_HOOK_FAILED",
  "AGENT_CONNECTION",
  "AGENT_JOB_FAILED",
  "AGENT_DISK_REPORT",
  "AGENT_DISK_THRESHOLD",
  "AGENT_DISK_STATE_CHANGED",
  "AGENT_DISK_CLEANUP_RESULT",
  "CCUSAGE_THRESHOLD",
  "WORKTREE_CREATED",
  "WORKTREE_BEHIND",
  "WORKTREE_CONFLICT",
  "WORKTREE_MISSING",
  "WORKTREE_DIVERGED",
  "WORKTREE_DIRTY_DURATION",
  "WORKTREE_NEW_COMMIT",
  "CODEBASE_REMOTE_BRANCH",
  "JIRA_STATUS",
  "JIRA_LABEL",
  "JIRA_ASSIGNED_SELF",
  "JIRA_SOURCE_NEW_TICKET",
  "JIRA_MENTION",
  "JIRA_SPRINT_STARTED",
  "JIRA_ISSUE_CREATED",
  "JIRA_ISSUE_DELETED",
  "JIRA_ISSUE_COMMAND",
  "JIRA_ATTACHMENT_ADDED",
  "JIRA_ISSUE_LINKED",
  "RUN_STARTED",
  "RUN_COMPLETED",
  "RUN_QUESTION_NEEDED",
  "RUN_QUESTION_ANSWERED",
  "RUN_PAUSED",
  "RUN_CONTINUED",
  "RUN_FAILED",
  "RUN_CANCELLED",
  "RUN_PLAN_PLAYED",
  "RUN_FOLLOW_UP",
  "RUN_IMPORTED",
  "RUN_USAGE_THRESHOLD",
  "RUN_EVENT_MATCH",
  "COMMAND_RUN_RESULT",
  "COMMAND_OUTPUT_MATCH",
  "SKILL_SYNC_RESULT",
  "SKILL_SYNC_CONFLICT",
  "GITHUB_PIPELINE_STATUS_CHANGED",
  "GITHUB_PR_SYNCHRONIZED",
  "GITHUB_REVIEW_APPROVED",
  "GITLAB_PIPELINE_STATUS_CHANGED",
  "GITLAB_MR_SYNCHRONIZED",
  "GITLAB_REVIEW_APPROVED",
  "GITLAB_JOB_STATUS_CHANGED",
  "JIRA_TICKET_UPDATED",
  "JIRA_COMMENT_ADDED",
  "JIRA_WORKLOG_ADDED",
  "JIRA_SPRINT_ENDED",
  "CODEBASE_SYNC_STATE_CHANGED",
  "CODEBASE_OPERATION_FAILED",
  "WORKTREE_SYNC_STATE_CHANGED",
  "WORKTREE_AUTOMATION_RESULT",
  "WORKTREE_CLEAN",
  "PUSH_NOTIFICATION_RESULT",
  "IOS_DEVICE_ENROLLED",
  "IOS_DEVICE_REGISTRATION_RESULT",
  "SIGNING_OPERATION_RESULT",
  "SIGNING_ASSET_EXPIRING",
  "BUILD_DATA_THRESHOLD",
  "BUILD_DATA_CLEANUP_RESULT",
  "POLLING_OPERATION_STATE",
  "MODEL_COST_CATALOG_CHANGED",
  "CREDENTIAL_STORE_DEGRADED",
  "AGENT_RESOURCE_THRESHOLD",
  "AGENT_VERSION_CHANGED",
  "TOOL_CALL_RESULT",
  "SSE_REQUEST_OPENED",
  "SSE_EVENT_EMITTED",
  "SSE_BREAKPOINT_WAITING",
  "SSE_BREAKPOINT_RESOLVED",
  "SSE_STREAM_COMPLETED",
  "SSE_STREAM_FAILED",
];

const TRIGGER_CONFIG_DESCRIPTORS: TriggerConfigDescriptors = Object.fromEntries(
  ALL_TRIGGER_KINDS.map((kind) => {
    if (kind === "RESOURCE_MANUAL" || kind === "RESOURCE_MANUAL_CHOICE") {
      return [
        kind,
        triggerWithFilters([
          enumField(
            "resourceKind",
            "Resource kind",
            staticOptions(WORKFLOW_RESOURCE_KINDS),
            { required: true },
          ),
          ...(kind === "RESOURCE_MANUAL_CHOICE"
            ? [triggerChoices("choices", "Choices", { required: true })]
            : []),
        ]),
      ];
    }
    if (kind === "MANUAL_CHOICE") {
      return [
        kind,
        triggerWithFilters([
          triggerChoices("choices", "Choices", { required: true }),
        ]),
      ];
    }
    if (kind === "SCHEDULE") {
      return [
        kind,
        triggerWithFilters([
          num("cadenceSeconds", "Cadence (seconds)", { required: true }),
        ]),
      ];
    }
    if (kind === "GITHUB_ISSUE_COMMAND" || kind === "GITLAB_NOTE_COMMAND") {
      const gitlab = kind === "GITLAB_NOTE_COMMAND";
      return [
        kind,
        triggerWithFilters([
          stringList(
            gitlab ? "allowedUsernames" : "allowedLogins",
            gitlab ? "Allowed usernames" : "Allowed logins",
            {
              placeholder: "octocat",
              required: true,
            },
          ),
          text("commandPattern", "Command pattern (RE2)", {
            placeholder: "^/deploy\\b$",
            required: true,
            // The matcher compiles this itself, so it has to stay a string: a
            // session binding would arrive as an object. Interpolation keeps it
            // a string, so tokens are still allowed.
            valueModes: ["literal", "interpolation"],
          }),
        ]),
      ];
    }
    if (kind === "JIRA_ISSUE_COMMAND") {
      return [
        kind,
        triggerWithFilters([
          // Jira identifies commenters by opaque account ID, not a handle, so
          // the allow-list cannot be a display name.
          stringList("allowedAccountIds", "Allowed account IDs", {
            placeholder: "5b10a2844c20165700ede21g",
            required: true,
          }),
          text("commandPattern", "Command pattern (RE2)", {
            placeholder: "^/deploy\\b$",
            required: true,
            valueModes: ["literal", "interpolation"],
          }),
        ]),
      ];
    }
    if (kind === "COMMAND_OUTPUT_MATCH") {
      return [
        kind,
        triggerWithFilters([
          text("outputPattern", "Output pattern (RE2)", {
            placeholder: "error|failed",
            required: true,
            valueModes: ["literal", "interpolation"],
          }),
        ]),
      ];
    }
    if (THRESHOLD_TRIGGERS.includes(kind)) {
      return [kind, triggerWithFilters(thresholdFields())];
    }
    return [kind, triggerWithFilters()];
  }),
) as TriggerConfigDescriptors;

// ---------------------------------------------------------------------------
// Public accessors.
// ---------------------------------------------------------------------------

export function getConfigDescriptor(
  kind: string,
  scope: ConfigFieldScope,
): KindConfigDescriptor | undefined {
  return scope === "step"
    ? STEP_CONFIG_DESCRIPTORS[kind as WorkflowStepKind]
    : TRIGGER_CONFIG_DESCRIPTORS[kind as WorkflowTriggerKind];
}

export function hasConfigDescriptor(
  kind: string,
  scope: ConfigFieldScope,
): boolean {
  return Boolean(getConfigDescriptor(kind, scope));
}

/**
 * The config keys a kind describes, with the subset it marks required. The
 * `model` control spans three sibling keys, of which only its primary `key`
 * counts as required — the same split `configSchemaForKind` publishes.
 */
function configKeys(
  kind: string,
  scope: ConfigFieldScope,
): { described: Set<string>; required: Set<string> } | null {
  const descriptor = getConfigDescriptor(kind, scope);
  if (!descriptor) return null;
  const described = new Set<string>();
  const required = new Set<string>();
  for (const field of descriptor.fields) {
    const keys =
      field.control === "model" && field.modelKeys
        ? [
            field.modelKeys.provider,
            field.modelKeys.model,
            field.modelKeys.effort,
          ]
        : [field.key];
    for (const key of keys) described.add(key);
    if (field.required) required.add(field.key);
  }
  return { described, required };
}

/**
 * The session paths a config binds that have to exist before the step can run.
 *
 * Only bindings on keys the descriptor marks required gate execution. An
 * optional key is exactly that at run time: `resolveWorkflowValue` yields
 * undefined, `{{tokens}}` interpolate to nothing, and the adapters read the
 * result through `optionalText` with their own session fallbacks. Gating on one
 * blocked whole runs over data the step never needed — "Run AI session" merely
 * offers a Jira issue key, so a worktree with no ticket must still start it.
 * Steps that genuinely cannot work without a value declare it in the catalog's
 * `requiredPaths`, which stay strict. So do kinds with no descriptor and keys it
 * does not describe (the editor's raw-JSON escape hatch), where there is nothing
 * to say the value is optional.
 */
export function requiredConfigSessionPaths(
  kind: string,
  scope: ConfigFieldScope,
  config: unknown,
): Set<string> {
  const keys = configKeys(kind, scope);
  if (!keys || !config || typeof config !== "object" || Array.isArray(config)) {
    return workflowValueSessionPaths(config);
  }
  const paths = new Set<string>();
  for (const [key, value] of Object.entries(
    config as Record<string, unknown>,
  )) {
    if (keys.described.has(key) && !keys.required.has(key)) continue;
    workflowValueSessionPaths(value, paths);
  }
  return paths;
}

export { STEP_CONFIG_DESCRIPTORS, TRIGGER_CONFIG_DESCRIPTORS };
