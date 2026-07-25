/**
 * The closed vocabularies a workflow is built from: which steps exist, which
 * triggers exist, and which resources a run can be launched against.
 *
 * These live apart from `definition.ts` because the config descriptors
 * (`config-descriptors.ts`) are keyed by these kinds, and `definition.ts` in
 * turn derives its catalog config schemas from those descriptors. Splitting the
 * vocabulary out breaks that cycle. `definition.ts` re-exports everything here,
 * so importers can keep reaching for either module.
 *
 * Pure data + pure predicates: safe to import on both the server and the client.
 */

export const WORKFLOW_STEP_KINDS = [
  "JIRA_LOAD_TICKET",
  "JIRA_TRANSITION",
  "JIRA_COMMENT",
  "JIRA_ASSIGN",
  "JIRA_UPDATE_FIELDS",
  "JIRA_RESOLVE_BRANCH",
  "GITHUB_LOAD_PR",
  "GITHUB_MERGE_PR",
  "GITHUB_COLLECT_REVIEW_THREADS",
  "GITHUB_REPLY_REVIEW_THREAD",
  "GITHUB_SET_REVIEW_THREAD_RESOLVED",
  "GITHUB_CREATE_PR",
  "GITHUB_SET_PR_LABELS",
  "GITHUB_RETRY_PIPELINE",
  "GITHUB_RETRY_JOB",
  "GITHUB_CANCEL_WORKFLOW_RUN",
  "GITHUB_SAVE_AUTO_RETRY",
  "GITHUB_WAIT_CHECKS",
  "WORKTREE_CREATE",
  "WORKTREE_CHANGE_BRANCH",
  "WORKTREE_OPERATION",
  "WORKTREE_DELETE",
  "WORKTREE_MOVE",
  "WORKTREE_INSPECT",
  "WORKTREE_INSPECT_GIT",
  "WORKTREE_GIT_OPERATION",
  "WORKTREE_WAIT_PUSH_READY",
  "WORKTREE_SNAPSHOT",
  "CODEBASE_FETCH_REFRESH",
  "CODEBASE_INSPECT_GIT",
  "CODEBASE_GIT_OPERATION",
  "BUILD_START",
  "BUILD_READ_TEST_RESULTS",
  "BUILD_READ_COVERAGE",
  "BUILD_EXPORT",
  "BUILD_DEPLOY",
  "BUILD_CANCEL",
  "SKILL_APPLY",
  "RUN_CREATE_PLAN",
  "RUN_CREATE_SESSION",
  "RUN_PLAY_PLAN",
  "RUN_FOLLOW_UP",
  "RUN_STEER",
  "RUN_ANSWER",
  "RUN_PAUSE",
  "RUN_CONTINUE",
  "RUN_CANCEL",
  "RUN_REVISE_ANSWER",
  "RUN_READ_RESULT",
  "RUN_CAPTURE_CHECKPOINT",
  "RUN_ARCHIVE_DELETE",
  "NOTIFICATION_SEND",
  "IOS_PUSH_SEND",
  "HUMAN_CONFIRM",
  "HUMAN_CHOICE",
  "CONTROL_IF",
  "CONTROL_JOIN",
  "CONTROL_DELAY",
  "CONTROL_WAIT_UNTIL",
  "CONTROL_FOR_EACH",
  "CONTROL_TRY",
  "CONTROL_SET_VARIABLE",
  "CONTROL_SUBWORKFLOW",
  "TERMINAL_RUN",
  "MCP_CALL",
] as const;

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

export const WORKFLOW_TRIGGER_KINDS = [
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
  "BUILD_RESULT",
  "BUILD_TEST_THRESHOLD",
  "BUILD_COVERAGE_THRESHOLD",
  "BUILD_HOOK_FAILED",
  "AGENT_CONNECTION",
  "AGENT_JOB_FAILED",
  "AGENT_DISK_THRESHOLD",
  "CCUSAGE_THRESHOLD",
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
] as const;

export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_KINDS)[number];

/**
 * Resource kinds a resource trigger can be launched from. Each kind maps
 * to the session-data paths the resource page seeds when it starts the run (see
 * `RESOURCE_KIND_SEED_PATHS` and `src/app/[locale]/*​/page.tsx` →
 * workflow-resource-panel). A trigger targets exactly one kind; to accept
 * several resource types, add one resource trigger per kind.
 */
export const WORKFLOW_RESOURCE_KINDS = [
  "BUILD",
  "CODEBASE",
  "JIRA_TICKET",
  "AGENT_RUN",
  "GITHUB_PIPELINE",
  "GITHUB_JOB",
  "PULL_REQUEST",
  "WORKTREE",
] as const;

export type WorkflowResourceKind = (typeof WORKFLOW_RESOURCE_KINDS)[number];

export const WORKFLOW_QUICK_ACTION_KINDS = [
  "STANDARD",
  "MERGE_CONFLICT",
  "GITHUB_ACTIONS",
  "NONE",
] as const;

export type WorkflowQuickActionKind =
  (typeof WORKFLOW_QUICK_ACTION_KINDS)[number];

/**
 * The manual trigger kinds come in pairs: a plain one, and a `*_CHOICE` one for
 * when the person starting the run picks an option first. A choice trigger
 * offers the options in its `choices` config, drops a menu under the run
 * button, and routes the run out of the handle named after the option that was
 * picked — so one workflow can fan out into several entry paths without a step
 * in front of them.
 */
const CHOICE_TRIGGER_KINDS = new Set<string>([
  "MANUAL_CHOICE",
  "RESOURCE_MANUAL_CHOICE",
]);

const RESOURCE_TRIGGER_KINDS = new Set<string>([
  "RESOURCE_MANUAL",
  "RESOURCE_MANUAL_CHOICE",
]);

/** Whether a trigger kind routes its run out of a per-option handle. */
export function isChoiceTriggerKind(kind: string): boolean {
  return CHOICE_TRIGGER_KINDS.has(kind);
}

/** Whether a trigger kind is launched from a resource page rather than the workflow. */
export function isResourceTriggerKind(kind: string): boolean {
  return RESOURCE_TRIGGER_KINDS.has(kind);
}

/** Handle-id shape for a choice key — kept in step with `workflowEdgeSchema`. */
export const WORKFLOW_CHOICE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isWorkflowChoiceKey(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_CHOICE_KEY_PATTERN.test(value);
}

/**
 * The outgoing connectors a kind offers, for the kinds whose handles are fixed.
 * Most steps branch on success/failure; the control-flow kinds name their
 * branches instead. Choice triggers return nothing here because their handles
 * come from the options in their config — `workflowSourceHandles` in
 * `components/workflows/workflow-graph.tsx` layers that on top.
 *
 * An edge leaving a handle not listed here never becomes ACTIVE, so this is the
 * set an author has to pick `sourceHandle` from (see `edgeState` in
 * `services/workflows/workflows.service.ts`).
 */
export function workflowStaticSourceHandles(kind: string): string[] {
  if (isChoiceTriggerKind(kind)) return [];
  if (kind === "CONTROL_IF") return ["true", "false"];
  if (kind === "CONTROL_FOR_EACH") return ["body", "empty"];
  if (kind === "CONTROL_TRY") return ["success", "catch"];
  return ["success", "failure"];
}
