import { z } from "zod";

import {
  invalidWorkflowValueBindings,
  workflowValueSessionPaths,
} from "./session";

export const WORKFLOW_FORMAT = "aide.workflow" as const;
export const WORKFLOW_SCHEMA_VERSION = 1 as const;

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
  "RESOURCE_MANUAL",
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

export type WorkflowCatalogEntry = {
  kind: WorkflowStepKind;
  category: string;
  label: string;
  description: string;
  execution: "SERVER" | "AGENT" | "CONTROL" | "WAIT";
  configSchema: Record<string, unknown>;
  capabilityFlags: string[];
  requiredPaths: string[];
  providedPaths: string[];
  mutatesExternal: boolean;
  mutatesWorktree: boolean;
};

const step = (
  kind: WorkflowStepKind,
  category: string,
  label: string,
  execution: WorkflowCatalogEntry["execution"],
  requiredPaths: string[] = [],
  providedPaths: string[] = [],
  options: Partial<
    Pick<WorkflowCatalogEntry, "mutatesExternal" | "mutatesWorktree">
  > = {},
): WorkflowCatalogEntry => ({
  kind,
  category,
  label,
  description: label,
  execution,
  configSchema: { type: "object", additionalProperties: true },
  capabilityFlags: [
    execution,
    ...(options.mutatesExternal ? ["MUTATES_EXTERNAL"] : []),
    ...(options.mutatesWorktree ? ["MUTATES_WORKTREE"] : []),
  ],
  requiredPaths,
  providedPaths,
  mutatesExternal: options.mutatesExternal ?? false,
  mutatesWorktree: options.mutatesWorktree ?? false,
});

export const WORKFLOW_STEP_CATALOG: readonly WorkflowCatalogEntry[] = [
  step(
    "JIRA_LOAD_TICKET",
    "Jira",
    "Load Jira ticket",
    "SERVER",
    [],
    ["ticket.*"],
  ),
  step(
    "JIRA_TRANSITION",
    "Jira",
    "Transition Jira ticket",
    "SERVER",
    ["ticket.key"],
    ["ticket.status"],
    { mutatesExternal: true },
  ),
  step(
    "JIRA_COMMENT",
    "Jira",
    "Add Jira comment",
    "SERVER",
    ["ticket.key"],
    [],
    { mutatesExternal: true },
  ),
  step(
    "JIRA_ASSIGN",
    "Jira",
    "Assign Jira ticket",
    "SERVER",
    ["ticket.key"],
    ["ticket.assignee"],
    { mutatesExternal: true },
  ),
  step(
    "JIRA_UPDATE_FIELDS",
    "Jira",
    "Update Jira fields",
    "SERVER",
    ["ticket.key"],
    ["ticket.labels"],
    { mutatesExternal: true },
  ),
  step(
    "JIRA_RESOLVE_BRANCH",
    "Jira",
    "Resolve ticket branch",
    "SERVER",
    ["ticket.key", "ticket.title", "ticket.type"],
    ["worktree.branch"],
  ),
  step("GITHUB_LOAD_PR", "GitHub", "Load pull request", "SERVER", [], ["pr.*"]),
  step(
    "GITHUB_MERGE_PR",
    "GitHub",
    "Merge pull request",
    "SERVER",
    ["pr.number"],
    ["pr.state"],
    { mutatesExternal: true },
  ),
  step(
    "GITHUB_COLLECT_REVIEW_THREADS",
    "GitHub",
    "Collect review comments",
    "SERVER",
    ["pr.number"],
    ["pr.unresolvedThreads"],
  ),
  step(
    "GITHUB_REPLY_REVIEW_THREAD",
    "GitHub",
    "Reply to review thread",
    "SERVER",
    ["pr.unresolvedThreads"],
    [],
    { mutatesExternal: true },
  ),
  step(
    "GITHUB_SET_REVIEW_THREAD_RESOLVED",
    "GitHub",
    "Resolve review thread",
    "SERVER",
    ["pr.unresolvedThreads"],
    [],
    { mutatesExternal: true },
  ),
  step(
    "GITHUB_CREATE_PR",
    "GitHub",
    "Open pull request",
    "SERVER",
    ["worktree.branch", "worktree.baseBranch"],
    ["pr.*"],
    { mutatesExternal: true },
  ),
  step(
    "GITHUB_SET_PR_LABELS",
    "GitHub",
    "Set pull request labels",
    "SERVER",
    ["pr.number"],
    ["pr.labels"],
    { mutatesExternal: true },
  ),
  step(
    "GITHUB_RETRY_PIPELINE",
    "GitHub Actions",
    "Retry failed pipeline",
    "SERVER",
    ["pipeline.runId"],
    ["pipeline.status"],
    { mutatesExternal: true },
  ),
  step(
    "GITHUB_RETRY_JOB",
    "GitHub Actions",
    "Retry workflow job",
    "SERVER",
    ["pipeline.failedJobs"],
    [],
    { mutatesExternal: true },
  ),
  step(
    "GITHUB_CANCEL_WORKFLOW_RUN",
    "GitHub Actions",
    "Cancel workflow run",
    "SERVER",
    ["pipeline.runId"],
    ["pipeline.status"],
    { mutatesExternal: true },
  ),
  step(
    "GITHUB_SAVE_AUTO_RETRY",
    "GitHub Actions",
    "Install auto-retry rule",
    "SERVER",
    ["pipeline.runId"],
    [],
    { mutatesExternal: true },
  ),
  step(
    "GITHUB_WAIT_CHECKS",
    "GitHub Actions",
    "Wait for checks",
    "WAIT",
    ["pipeline.runId"],
    ["pipeline.status", "pipeline.conclusion"],
  ),
  step(
    "WORKTREE_CREATE",
    "Worktrees",
    "Create worktree",
    "SERVER",
    ["codebase.id"],
    ["worktree.*"],
    { mutatesWorktree: true },
  ),
  step(
    "WORKTREE_CHANGE_BRANCH",
    "Worktrees",
    "Change worktree branch",
    "SERVER",
    ["worktree.id"],
    ["worktree.branch"],
    { mutatesWorktree: true },
  ),
  step(
    "WORKTREE_OPERATION",
    "Worktrees",
    "Run worktree operation",
    "SERVER",
    ["worktree.id"],
    ["worktree.pushStatus"],
    { mutatesWorktree: true },
  ),
  step(
    "WORKTREE_DELETE",
    "Worktrees",
    "Delete worktree",
    "SERVER",
    ["worktree.id"],
    [],
    { mutatesWorktree: true },
  ),
  step(
    "WORKTREE_MOVE",
    "Worktrees",
    "Move worktree",
    "SERVER",
    ["worktree.id"],
    ["worktree.*"],
    { mutatesWorktree: true },
  ),
  step(
    "WORKTREE_INSPECT",
    "Worktrees",
    "Inspect worktree",
    "SERVER",
    ["worktree.id"],
    ["worktree.commits", "worktree.changes"],
  ),
  step(
    "WORKTREE_INSPECT_GIT",
    "Worktrees",
    "Inspect worktree Git state",
    "SERVER",
    ["worktree.id"],
    ["worktree.dirty"],
  ),
  step(
    "WORKTREE_GIT_OPERATION",
    "Worktrees",
    "Run worktree Git operation",
    "SERVER",
    ["worktree.id"],
    [],
    { mutatesWorktree: true },
  ),
  step(
    "WORKTREE_WAIT_PUSH_READY",
    "Worktrees",
    "Wait for push-ready",
    "WAIT",
    ["worktree.id"],
    ["worktree.pushStatus"],
  ),
  step(
    "WORKTREE_SNAPSHOT",
    "Worktrees",
    "Snapshot Git state",
    "AGENT",
    ["worktree.path"],
    ["steps.<stepId>.snapshotId"],
  ),
  step(
    "CODEBASE_FETCH_REFRESH",
    "Codebases",
    "Fetch or refresh codebase",
    "SERVER",
    ["codebase.id"],
    ["codebase.headSha", "codebase.branch"],
    { mutatesWorktree: true },
  ),
  step(
    "CODEBASE_INSPECT_GIT",
    "Codebases",
    "Inspect codebase Git state",
    "SERVER",
    ["codebase.id"],
    ["codebase.dirty"],
  ),
  step(
    "CODEBASE_GIT_OPERATION",
    "Codebases",
    "Run codebase Git operation",
    "SERVER",
    ["codebase.id"],
    [],
    { mutatesWorktree: true },
  ),
  step(
    "BUILD_START",
    "Builds",
    "Start build or test",
    "SERVER",
    ["codebase.id", "worktree.id"],
    ["build.*"],
    { mutatesExternal: true },
  ),
  step(
    "BUILD_READ_TEST_RESULTS",
    "Builds",
    "Read test results",
    "SERVER",
    ["build.id"],
    ["build.testSummary"],
  ),
  step(
    "BUILD_READ_COVERAGE",
    "Builds",
    "Read code coverage",
    "SERVER",
    ["build.id"],
    ["build.coverageSummary"],
  ),
  step(
    "BUILD_EXPORT",
    "Builds",
    "Export archive",
    "SERVER",
    ["build.id"],
    ["build.artifacts"],
    { mutatesExternal: true },
  ),
  step("BUILD_DEPLOY", "Builds", "Deploy build", "SERVER", ["build.id"], [], {
    mutatesExternal: true,
  }),
  step(
    "BUILD_CANCEL",
    "Builds",
    "Cancel build",
    "SERVER",
    ["build.id"],
    ["build.status"],
    { mutatesExternal: true },
  ),
  step(
    "SKILL_APPLY",
    "Skills",
    "Apply skill group",
    "SERVER",
    ["worktree.id", "repo.id"],
    ["steps.<stepId>.status"],
    { mutatesWorktree: true },
  ),
  step(
    "RUN_CREATE_PLAN",
    "AI runs",
    "Create plan and wait",
    "SERVER",
    ["worktree.id"],
    ["run.<stepId>.*"],
  ),
  step(
    "RUN_CREATE_SESSION",
    "AI runs",
    "Run AI session and wait",
    "SERVER",
    ["worktree.id"],
    ["run.<stepId>.*"],
    { mutatesWorktree: true },
  ),
  step(
    "RUN_PLAY_PLAN",
    "AI runs",
    "Run completed plan",
    "SERVER",
    [],
    ["run.<stepId>.*"],
    { mutatesWorktree: true },
  ),
  step(
    "RUN_FOLLOW_UP",
    "AI runs",
    "Follow up run",
    "SERVER",
    [],
    ["run.<stepId>.*"],
  ),
  step("RUN_STEER", "AI runs", "Steer active run", "SERVER"),
  step("RUN_ANSWER", "AI runs", "Answer run question", "SERVER"),
  step("RUN_PAUSE", "AI runs", "Pause run", "SERVER"),
  step("RUN_CONTINUE", "AI runs", "Continue run", "SERVER"),
  step("RUN_CANCEL", "AI runs", "Cancel run", "SERVER"),
  step(
    "RUN_REVISE_ANSWER",
    "AI runs",
    "Revise answer and rewind",
    "SERVER",
    [],
    ["run.<stepId>.*"],
    { mutatesWorktree: true },
  ),
  step(
    "RUN_READ_RESULT",
    "AI runs",
    "Read run result",
    "SERVER",
    [],
    ["run.<stepId>.*"],
  ),
  step(
    "RUN_CAPTURE_CHECKPOINT",
    "AI runs",
    "Capture run checkpoint",
    "SERVER",
    [],
    ["steps.<stepId>.snapshotId"],
  ),
  step(
    "RUN_ARCHIVE_DELETE",
    "AI runs",
    "Archive or delete run",
    "SERVER",
    [],
    [],
    { mutatesExternal: true },
  ),
  step(
    "NOTIFICATION_SEND",
    "Human loop",
    "Send notification",
    "SERVER",
    [],
    [],
    { mutatesExternal: true },
  ),
  step("IOS_PUSH_SEND", "Human loop", "Push to iOS device", "SERVER", [], [], {
    mutatesExternal: true,
  }),
  step(
    "HUMAN_CONFIRM",
    "Human loop",
    "Request confirmation",
    "WAIT",
    [],
    ["steps.<stepId>.answer"],
  ),
  step(
    "HUMAN_CHOICE",
    "Human loop",
    "Ask user to choose",
    "WAIT",
    [],
    ["steps.<stepId>.answer"],
  ),
  step("CONTROL_IF", "Control flow", "If / else", "CONTROL"),
  step("CONTROL_JOIN", "Control flow", "Join branches", "CONTROL"),
  step("CONTROL_DELAY", "Control flow", "Time delay", "WAIT"),
  step("CONTROL_WAIT_UNTIL", "Control flow", "Wait until", "WAIT"),
  step("CONTROL_FOR_EACH", "Control flow", "For each", "CONTROL"),
  step("CONTROL_TRY", "Control flow", "Try / catch", "CONTROL"),
  step(
    "CONTROL_SET_VARIABLE",
    "Control flow",
    "Set or compute variable",
    "CONTROL",
  ),
  step("CONTROL_SUBWORKFLOW", "Control flow", "Call sub-workflow", "SERVER"),
  step(
    "TERMINAL_RUN",
    "Extensibility",
    "Run terminal script",
    "AGENT",
    ["worktree.path"],
    ["steps.<stepId>.*"],
    { mutatesWorktree: true },
  ),
  step(
    "MCP_CALL",
    "Extensibility",
    "Call MCP tool",
    "SERVER",
    [],
    ["steps.<stepId>.output"],
    { mutatesExternal: true },
  ),
];

export const WORKFLOW_STEP_BY_KIND = new Map(
  WORKFLOW_STEP_CATALOG.map((entry) => [entry.kind, entry]),
);

export type WorkflowTriggerCatalogEntry = {
  kind: WorkflowTriggerKind;
  category: string;
  label: string;
  configSchema: Record<string, unknown>;
  capabilityFlags: string[];
  seedPaths: string[];
};

/**
 * The session data `WorkflowEventBridge.observeRun` seeds for every run
 * lifecycle trigger. All run-based kinds (RUN_STARTED, RUN_FAILED,
 * RUN_COMPLETED, RUN_CANCELLED, …) share the same `sessionData` object, so
 * they must advertise the same seed paths — otherwise a trigger like
 * RUN_FAILED appears to provide less than RUN_STARTED even though the bridge
 * hands both identical data.
 */
const RUN_SEED_PATHS = [
  "run.*",
  "worktree.*",
  "codebase.*",
  "repo.*",
  "ticket.*",
];

const trigger = (
  kind: WorkflowTriggerKind,
  category: string,
  label: string,
  seedPaths: string[] = [],
): WorkflowTriggerCatalogEntry => ({
  kind,
  category,
  label,
  configSchema: { type: "object", additionalProperties: true },
  capabilityFlags: ["DURABLE", "DEDUPLICATED"],
  seedPaths,
});

export const WORKFLOW_TRIGGER_CATALOG: readonly WorkflowTriggerCatalogEntry[] =
  [
    trigger("MANUAL", "Manual", "Manual run"),
    trigger("RESOURCE_MANUAL", "Manual", "Run from a resource", [
      "repo.*",
      "codebase.*",
      "ticket.*",
      "worktree.*",
      "pr.*",
      "pipeline.*",
      "build.*",
      "run.*",
    ]),
    trigger("SCHEDULE", "Schedule", "On a schedule"),
    trigger("WORKFLOW_FINISHED", "Workflows", "Another workflow finished", [
      "workflow.*",
    ]),
    trigger("GITHUB_PR_STATE", "GitHub", "Pull request opened or ready", [
      "repo.*",
      "pr.*",
    ]),
    trigger("GITHUB_REVIEW_CHANGES_REQUESTED", "GitHub", "Changes requested", [
      "repo.*",
      "pr.*",
    ]),
    trigger("GITHUB_REVIEW_COMMENT", "GitHub", "Review comment created", [
      "repo.*",
      "pr.*",
    ]),
    trigger("GITHUB_PR_CLOSED", "GitHub", "Pull request merged or closed", [
      "repo.*",
      "pr.*",
    ]),
    trigger("GITHUB_CHECK_FAILED", "GitHub", "Check suite or run failed", [
      "repo.*",
      "pipeline.*",
    ]),
    trigger("GITHUB_PUSH_DEFAULT", "GitHub", "Push to default branch", [
      "repo.*",
    ]),
    trigger("GITHUB_WORKFLOW_SUCCEEDED", "GitHub", "Workflow run succeeded", [
      "repo.*",
      "pipeline.*",
    ]),
    trigger("GITHUB_ISSUE_COMMAND", "GitHub", "Issue comment command", [
      "repo.*",
      "pr.*",
    ]),
    trigger("GITHUB_ACTIONS_RESULT", "GitHub Actions", "Workflow result", [
      "repo.*",
      "pipeline.*",
      "pr.*",
      "ticket.*",
    ]),
    trigger("GITHUB_PR_LABEL", "GitHub", "Pull request label set", [
      "repo.*",
      "pr.*",
    ]),
    trigger("BUILD_RESULT", "Builds", "Build result", [
      "repo.*",
      "worktree.*",
      "build.*",
    ]),
    trigger("BUILD_TEST_THRESHOLD", "Builds", "Test failure threshold", [
      "build.*",
    ]),
    trigger("BUILD_COVERAGE_THRESHOLD", "Builds", "Coverage threshold", [
      "build.*",
    ]),
    trigger("BUILD_HOOK_FAILED", "Builds", "Build hook failed", ["build.*"]),
    trigger("AGENT_CONNECTION", "Agents", "Agent connection changed", [
      "codebase.agentId",
    ]),
    trigger("AGENT_JOB_FAILED", "Agents", "Agent job failed", [
      "steps.trigger.*",
    ]),
    trigger("AGENT_DISK_THRESHOLD", "Agents", "Agent disk threshold", [
      "codebase.agentId",
    ]),
    trigger("CCUSAGE_THRESHOLD", "Agents", "Usage threshold", ["run.usage.*"]),
    trigger("WORKTREE_BEHIND", "Worktrees", "Worktree behind base", [
      "worktree.*",
    ]),
    trigger("WORKTREE_CONFLICT", "Worktrees", "Worktree has conflicts", [
      "worktree.*",
    ]),
    trigger("WORKTREE_MISSING", "Worktrees", "Worktree missing", [
      "worktree.*",
    ]),
    trigger("WORKTREE_DIVERGED", "Worktrees", "Worktree diverged", [
      "worktree.*",
    ]),
    trigger("WORKTREE_DIRTY_DURATION", "Worktrees", "Worktree dirty too long", [
      "worktree.*",
    ]),
    trigger("WORKTREE_NEW_COMMIT", "Worktrees", "New worktree commit", [
      "worktree.*",
    ]),
    trigger("CODEBASE_REMOTE_BRANCH", "Codebases", "Matching remote branch", [
      "codebase.*",
    ]),
    trigger("JIRA_STATUS", "Jira", "Ticket status changed", ["ticket.*"]),
    trigger("JIRA_LABEL", "Jira", "Jira label set", ["ticket.*"]),
    trigger("JIRA_ASSIGNED_SELF", "Jira", "Ticket assigned to me", [
      "ticket.*",
    ]),
    trigger("JIRA_SOURCE_NEW_TICKET", "Jira", "New ticket in source", [
      "ticket.*",
    ]),
    trigger("JIRA_MENTION", "Jira", "Jira comment mention", ["ticket.*"]),
    trigger("JIRA_SPRINT_STARTED", "Jira", "Sprint started", ["ticket.*"]),
    trigger("RUN_STARTED", "Plans and sessions", "Run started", RUN_SEED_PATHS),
    trigger(
      "RUN_COMPLETED",
      "Plans and sessions",
      "Run completed",
      RUN_SEED_PATHS,
    ),
    trigger(
      "RUN_QUESTION_NEEDED",
      "Plans and sessions",
      "Run needs an answer",
      RUN_SEED_PATHS,
    ),
    trigger(
      "RUN_QUESTION_ANSWERED",
      "Plans and sessions",
      "Run question answered",
      RUN_SEED_PATHS,
    ),
    trigger("RUN_PAUSED", "Plans and sessions", "Run paused", RUN_SEED_PATHS),
    trigger(
      "RUN_CONTINUED",
      "Plans and sessions",
      "Run continued",
      RUN_SEED_PATHS,
    ),
    trigger("RUN_FAILED", "Plans and sessions", "Run failed", RUN_SEED_PATHS),
    trigger(
      "RUN_CANCELLED",
      "Plans and sessions",
      "Run cancelled",
      RUN_SEED_PATHS,
    ),
    trigger(
      "RUN_PLAN_PLAYED",
      "Plans and sessions",
      "Plan played",
      RUN_SEED_PATHS,
    ),
    trigger(
      "RUN_FOLLOW_UP",
      "Plans and sessions",
      "Run follow-up created",
      RUN_SEED_PATHS,
    ),
    trigger(
      "RUN_IMPORTED",
      "Plans and sessions",
      "Provider run imported",
      RUN_SEED_PATHS,
    ),
    trigger(
      "RUN_USAGE_THRESHOLD",
      "Plans and sessions",
      "Run usage threshold",
      RUN_SEED_PATHS,
    ),
    trigger(
      "RUN_EVENT_MATCH",
      "Plans and sessions",
      "Run event or tool matched",
      RUN_SEED_PATHS,
    ),
  ];

export const WORKFLOW_TRIGGER_BY_KIND = new Map(
  WORKFLOW_TRIGGER_CATALOG.map((entry) => [entry.kind, entry]),
);

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const sessionPath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_*\[\]-]+)*$/);
const objectConfig = z.record(z.string(), z.unknown()).default({});

export const workflowInputSchema = z.object({
  id: identifier,
  path: sessionPath,
  label: z.string().min(1).max(200),
  type: z.enum(["STRING", "NUMBER", "BOOLEAN", "JSON", "ID"]),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  acceptedResourceKind: z.string().max(100).optional(),
});

export const workflowTriggerSchema = z.object({
  id: identifier,
  kind: z.enum(WORKFLOW_TRIGGER_KINDS),
  name: z.string().min(1).max(200).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  config: objectConfig,
});

export const workflowNodeSchema = z.object({
  id: identifier,
  kind: z.enum(WORKFLOW_STEP_KINDS),
  name: z.string().min(1).max(200).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  config: objectConfig,
  requiredPaths: z.array(sessionPath).max(100).default([]),
  providedPaths: z.array(sessionPath).max(100).default([]),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(20).default(1),
      strategy: z.enum(["FIXED", "EXPONENTIAL"]).default("EXPONENTIAL"),
      delaySeconds: z.number().int().min(1).max(86_400).default(5),
    })
    .default({ maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 }),
  failurePolicy: z.enum(["FAIL", "CONTINUE"]).default("FAIL"),
});

export const workflowEdgeSchema = z.object({
  id: identifier,
  source: identifier,
  target: identifier,
  sourceHandle: z.string().min(1).max(100).default("success"),
  targetHandle: z.string().min(1).max(100).default("input"),
});

export const workflowDefinitionSchema = z.object({
  format: z.literal(WORKFLOW_FORMAT),
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).default(""),
  inputs: z.array(workflowInputSchema).max(100).default([]),
  triggers: z.array(workflowTriggerSchema).max(100).default([]),
  nodes: z.array(workflowNodeSchema).max(1_000).default([]),
  edges: z.array(workflowEdgeSchema).max(5_000).default([]),
  editor: z
    .object({
      viewport: z
        .object({ x: z.number(), y: z.number(), zoom: z.number().positive() })
        .optional(),
    })
    .default({}),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowNodeDefinition = z.infer<typeof workflowNodeSchema>;
export type WorkflowTriggerDefinition = z.infer<typeof workflowTriggerSchema>;

export type WorkflowDiagnostic = {
  severity: "ERROR" | "WARNING";
  code: string;
  message: string;
  nodeId?: string;
  triggerId?: string;
  path?: string;
};

export function emptyWorkflowDefinition(
  name = "Untitled workflow",
): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    format: WORKFLOW_FORMAT,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name,
    description: "",
    inputs: [],
    triggers: [
      { id: "manual", kind: "MANUAL", position: { x: 0, y: 100 }, config: {} },
    ],
    nodes: [],
    edges: [],
    editor: {},
  });
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  return workflowDefinitionSchema.parse(value);
}

export function sanitizeWorkflowExportDefinition(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  const sanitize = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([childKey, entry]) => [childKey, sanitize(entry, childKey)],
        ),
      );
    }
    if (
      typeof value === "string" &&
      /(token|secret|password|passwd|private.?key|api.?key|authorization)/i.test(
        key,
      ) &&
      !/(credential.?id|credential.?ids)$/i.test(key)
    ) {
      return null;
    }
    if (
      typeof value === "string" &&
      /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value) &&
      /^(?:cwd|folder|path|directory)$/i.test(key)
    ) {
      return null;
    }
    return value;
  };
  return workflowDefinitionSchema.parse(sanitize(definition));
}

function expandedPaths(
  node: { id: string },
  paths: readonly string[],
): string[] {
  return paths.map((path) => path.replaceAll("<stepId>", node.id));
}

function pathCovers(provided: string, required: string): boolean {
  if (provided === required || provided === "*") return true;
  return provided.endsWith(".*") && required.startsWith(provided.slice(0, -1));
}

function pathsOverlap(first: string, second: string): boolean {
  return pathCovers(first, second) || pathCovers(second, first);
}

function intersection(sets: Set<string>[]): Set<string> {
  if (!sets.length) return new Set();
  return new Set(
    [...sets[0]!].filter((value) => sets.every((set) => set.has(value))),
  );
}

function hasPath(available: Set<string>, required: string): boolean {
  return [...available].some((provided) => pathCovers(provided, required));
}

/**
 * Supplies the required/provided/seed paths for a kind. The default reads the
 * in-memory catalog (server); the editor passes a lookup backed by the catalog
 * it fetches over GraphQL so the same reachability walk runs client-side.
 */
export type WorkflowPathLookup = {
  stepPaths(kind: string): { requiredPaths: string[]; providedPaths: string[] };
  triggerSeedPaths(kind: string): string[];
};

const defaultPathLookup: WorkflowPathLookup = {
  stepPaths(kind) {
    const entry = WORKFLOW_STEP_BY_KIND.get(kind as WorkflowStepKind);
    return {
      requiredPaths: entry?.requiredPaths ?? [],
      providedPaths: entry?.providedPaths ?? [],
    };
  },
  triggerSeedPaths(kind) {
    return (
      WORKFLOW_TRIGGER_BY_KIND.get(kind as WorkflowTriggerKind)?.seedPaths ?? []
    );
  },
};

export type WorkflowRequirementViolation = {
  nodeId: string;
  triggerId: string;
  triggerName: string;
  path: string;
};

/**
 * Structural shape of a definition the availability walk needs. Deliberately
 * loose so both the zod-inferred `WorkflowDefinition` (server) and the client
 * editor's hand-written definition type satisfy it.
 */
export type WorkflowAvailabilityInput = {
  inputs: readonly { path: string; required: boolean }[];
  triggers: readonly { id: string; kind: string; name?: string }[];
  nodes: readonly {
    id: string;
    kind: string;
    config: unknown;
    requiredPaths: readonly string[];
    providedPaths: readonly string[];
  }[];
  edges: readonly { source: string; target: string }[];
};

/**
 * Walks the workflow DAG from every trigger and computes, per step node, the
 * session paths guaranteed to exist *before* it runs (`availableBefore`, the
 * cross-trigger intersection — exactly what a step may bind its config to) and
 * the paths it contributes (`provides`). Also surfaces requirement violations
 * so `validateWorkflowDefinition` can raise `REQUIREMENT_UNSATISFIED`.
 */
export function computeWorkflowPathAvailability(
  definition: WorkflowAvailabilityInput,
  lookup: WorkflowPathLookup = defaultPathLookup,
): {
  availableBefore: Map<string, string[]>;
  provides: Map<string, string[]>;
  requirementViolations: WorkflowRequirementViolation[];
} {
  const nodeIds = new Set(definition.nodes.map(({ id }) => id));
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of definition.edges) {
    outgoing.set(edge.source, [
      ...(outgoing.get(edge.source) ?? []),
      edge.target,
    ]);
    incoming.set(edge.target, [
      ...(incoming.get(edge.target) ?? []),
      edge.source,
    ]);
  }

  const indegree = new Map(definition.nodes.map((node) => [node.id, 0]));
  for (const edge of definition.edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target))
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  const topological: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topological.push(id);
    for (const target of outgoing.get(id) ?? []) {
      if (!nodeIds.has(target)) continue;
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }

  const walk = (start: string): Set<string> => {
    const visited = new Set<string>();
    const pending = [...(outgoing.get(start) ?? [])];
    while (pending.length) {
      const id = pending.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(outgoing.get(id) ?? []));
    }
    return visited;
  };
  const reachability = new Map<string, Set<string>>();
  for (const item of [...definition.triggers, ...definition.nodes])
    reachability.set(item.id, walk(item.id));

  const provides = new Map<string, string[]>();
  for (const node of definition.nodes) {
    const catalog = lookup.stepPaths(node.kind);
    provides.set(node.id, [
      ...expandedPaths(node, catalog.providedPaths),
      ...node.providedPaths,
      `steps.${node.id}.*`,
    ]);
  }

  const guaranteedInputs = new Set(
    definition.inputs
      .filter(({ required }) => required)
      .map(({ path }) => path),
  );
  guaranteedInputs.add("workflow.*");

  const availableBefore = new Map<string, Set<string>>();
  const requirementViolations: WorkflowRequirementViolation[] = [];
  for (const triggerDefinition of definition.triggers) {
    const seed = new Set(guaranteedInputs);
    for (const path of lookup.triggerSeedPaths(triggerDefinition.kind))
      seed.add(path);
    const availableAfter = new Map<string, Set<string>>();
    for (const nodeId of topological) {
      if (!reachability.get(triggerDefinition.id)?.has(nodeId)) continue;
      const node = nodeById.get(nodeId)!;
      const sources = (incoming.get(nodeId) ?? []).filter(
        (source) =>
          source === triggerDefinition.id || availableAfter.has(source),
      );
      if (!sources.length) continue;
      const available = intersection(
        sources.map((source) =>
          source === triggerDefinition.id ? seed : availableAfter.get(source)!,
        ),
      );
      const existing = availableBefore.get(nodeId);
      availableBefore.set(
        nodeId,
        existing ? intersection([existing, available]) : new Set(available),
      );
      const required = new Set([
        ...expandedPaths(node, lookup.stepPaths(node.kind).requiredPaths),
        ...node.requiredPaths,
        ...workflowValueSessionPaths(node.config),
      ]);
      for (const path of required) {
        if (!hasPath(available, path))
          requirementViolations.push({
            nodeId: node.id,
            triggerId: triggerDefinition.id,
            triggerName: triggerDefinition.name ?? triggerDefinition.kind,
            path,
          });
      }
      const after = new Set(available);
      for (const path of provides.get(nodeId) ?? []) after.add(path);
      availableAfter.set(nodeId, after);
    }
  }

  return {
    availableBefore: new Map(
      [...availableBefore].map(([id, set]) => [id, [...set]]),
    ),
    provides,
    requirementViolations,
  };
}

function hasSensitiveLiteral(value: unknown, key = ""): boolean {
  if (Array.isArray(value))
    return value.some((entry) => hasSensitiveLiteral(entry, key));
  if (!value || typeof value !== "object") {
    return (
      typeof value === "string" &&
      /(token|secret|password|passwd|private.?key|api.?key|authorization)/i.test(
        key,
      ) &&
      !/(credential.?id|credential.?ids)$/i.test(key)
    );
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([childKey, entry]) => hasSensitiveLiteral(entry, childKey),
  );
}

function hasUnresolvedReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnresolvedReference);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.referenceStatus === "UNRESOLVED" ||
    Object.values(record).some(hasUnresolvedReference)
  );
}

export function validateWorkflowDefinition(value: unknown): {
  definition: WorkflowDefinition | null;
  diagnostics: WorkflowDiagnostic[];
} {
  const parsed = workflowDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    return {
      definition: null,
      diagnostics: parsed.error.issues.map((issue) => ({
        severity: "ERROR",
        code: "SCHEMA_INVALID",
        message: issue.message,
        path: issue.path.join("."),
      })),
    };
  }
  const definition = parsed.data;
  const diagnostics: WorkflowDiagnostic[] = [];
  const allIds = new Set<string>();
  for (const item of [...definition.triggers, ...definition.nodes]) {
    if (allIds.has(item.id)) {
      diagnostics.push({
        severity: "ERROR",
        code: "DUPLICATE_NODE_ID",
        message: `Duplicate graph id ${item.id}`,
        nodeId: item.id,
      });
    }
    allIds.add(item.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id))
      diagnostics.push({
        severity: "ERROR",
        code: "DUPLICATE_EDGE_ID",
        message: `Duplicate edge id ${edge.id}`,
      });
    edgeIds.add(edge.id);
    if (!allIds.has(edge.source) || !allIds.has(edge.target)) {
      diagnostics.push({
        severity: "ERROR",
        code: "EDGE_ENDPOINT_MISSING",
        message: `Edge ${edge.id} references a missing endpoint`,
      });
    }
    if (definition.triggers.some(({ id }) => id === edge.target)) {
      diagnostics.push({
        severity: "ERROR",
        code: "TRIGGER_HAS_INPUT",
        message: "Triggers cannot have incoming edges",
        triggerId: edge.target,
      });
    }
  }
  if (!definition.triggers.length)
    diagnostics.push({
      severity: "ERROR",
      code: "TRIGGER_REQUIRED",
      message: "At least one trigger is required",
    });
  if (!definition.nodes.length)
    diagnostics.push({
      severity: "ERROR",
      code: "STEP_REQUIRED",
      message: "At least one step is required",
    });

  const nodeIds = new Set(definition.nodes.map(({ id }) => id));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of definition.edges) {
    outgoing.set(edge.source, [
      ...(outgoing.get(edge.source) ?? []),
      edge.target,
    ]);
    incoming.set(edge.target, [
      ...(incoming.get(edge.target) ?? []),
      edge.source,
    ]);
  }
  for (const node of definition.nodes) {
    const parents = (incoming.get(node.id) ?? []).filter((id) =>
      nodeIds.has(id),
    );
    if (parents.length > 1 && node.kind !== "CONTROL_JOIN") {
      diagnostics.push({
        severity: "ERROR",
        code: "EXPLICIT_JOIN_REQUIRED",
        message:
          "Nodes with multiple incoming branches must be explicit join nodes",
        nodeId: node.id,
      });
    }
  }

  const indegree = new Map(definition.nodes.map((node) => [node.id, 0]));
  for (const edge of definition.edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target))
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  const topological: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topological.push(id);
    for (const target of outgoing.get(id) ?? []) {
      if (!nodeIds.has(target)) continue;
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (topological.length !== definition.nodes.length)
    diagnostics.push({
      severity: "ERROR",
      code: "DAG_CYCLE",
      message: "Workflow graphs cannot contain free-form cycles",
    });

  const reachability = new Map<string, Set<string>>();
  const walk = (start: string): Set<string> => {
    const visited = new Set<string>();
    const pending = [...(outgoing.get(start) ?? [])];
    while (pending.length) {
      const id = pending.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(outgoing.get(id) ?? []));
    }
    return visited;
  };
  for (const item of [...definition.triggers, ...definition.nodes])
    reachability.set(item.id, walk(item.id));
  for (const node of definition.nodes) {
    if (
      !definition.triggers.some((entry) =>
        reachability.get(entry.id)?.has(node.id),
      )
    ) {
      diagnostics.push({
        severity: "ERROR",
        code: "UNREACHABLE_STEP",
        message: "Step is not reachable from a trigger",
        nodeId: node.id,
      });
    }
    if (hasSensitiveLiteral(node.config))
      diagnostics.push({
        severity: "ERROR",
        code: "SECRET_LITERAL",
        message:
          "Store secrets as credential references, not workflow literals",
        nodeId: node.id,
      });
    if (hasUnresolvedReference(node.config))
      diagnostics.push({
        severity: "ERROR",
        code: "UNRESOLVED_REFERENCE",
        message: "Resolve imported references before publishing",
        nodeId: node.id,
      });
    for (const message of new Set(invalidWorkflowValueBindings(node.config)))
      diagnostics.push({
        severity: "ERROR",
        code: "SESSION_BINDING_INVALID",
        message,
        nodeId: node.id,
      });
    if (
      node.kind === "CONTROL_SUBWORKFLOW" &&
      typeof node.config.versionId !== "string"
    )
      diagnostics.push({
        severity: "ERROR",
        code: "SUBWORKFLOW_VERSION_REQUIRED",
        message: "Sub-workflows must pin a published version",
        nodeId: node.id,
      });
  }
  for (const triggerDefinition of definition.triggers) {
    if (!(outgoing.get(triggerDefinition.id) ?? []).length)
      diagnostics.push({
        severity: "ERROR",
        code: "TRIGGER_DISCONNECTED",
        message: "Trigger is not connected to a step",
        triggerId: triggerDefinition.id,
      });
    if (hasSensitiveLiteral(triggerDefinition.config))
      diagnostics.push({
        severity: "ERROR",
        code: "SECRET_LITERAL",
        message: "Store secrets as credential references, not trigger literals",
        triggerId: triggerDefinition.id,
      });
    if (hasUnresolvedReference(triggerDefinition.config))
      diagnostics.push({
        severity: "ERROR",
        code: "UNRESOLVED_REFERENCE",
        message: "Resolve imported references before publishing",
        triggerId: triggerDefinition.id,
      });
    for (const message of new Set(
      invalidWorkflowValueBindings(triggerDefinition.config),
    ))
      diagnostics.push({
        severity: "ERROR",
        code: "SESSION_BINDING_INVALID",
        message,
        triggerId: triggerDefinition.id,
      });
    if (triggerDefinition.kind === "GITHUB_ISSUE_COMMAND") {
      const allowed = triggerDefinition.config.allowedLogins;
      const pattern = triggerDefinition.config.commandPattern;
      if (
        !Array.isArray(allowed) ||
        !allowed.length ||
        allowed.some((entry) => typeof entry !== "string" || !entry.trim())
      )
        diagnostics.push({
          severity: "ERROR",
          code: "ISSUE_COMMAND_ALLOWLIST_REQUIRED",
          message:
            "Issue command triggers require an explicit GitHub login allow-list",
          triggerId: triggerDefinition.id,
        });
      if (
        typeof pattern !== "string" ||
        !pattern.startsWith("^") ||
        !pattern.endsWith("$")
      )
        diagnostics.push({
          severity: "ERROR",
          code: "ISSUE_COMMAND_PATTERN_ANCHORED",
          message: "Issue command patterns must be anchored with ^ and $",
          triggerId: triggerDefinition.id,
        });
    }
  }

  for (const violation of computeWorkflowPathAvailability(definition)
    .requirementViolations) {
    diagnostics.push({
      severity: "ERROR",
      code: "REQUIREMENT_UNSATISFIED",
      message: `${violation.path} is not guaranteed on the path from ${violation.triggerName}`,
      nodeId: violation.nodeId,
      triggerId: violation.triggerId,
      path: violation.path,
    });
  }

  for (
    let firstIndex = 0;
    firstIndex < definition.nodes.length;
    firstIndex += 1
  ) {
    const first = definition.nodes[firstIndex]!;
    const firstWrites = [
      ...expandedPaths(
        first,
        WORKFLOW_STEP_BY_KIND.get(first.kind)!.providedPaths,
      ),
      ...first.providedPaths,
    ].filter((path) => !path.startsWith(`steps.${first.id}.`));
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < definition.nodes.length;
      secondIndex += 1
    ) {
      const second = definition.nodes[secondIndex]!;
      if (
        reachability.get(first.id)?.has(second.id) ||
        reachability.get(second.id)?.has(first.id)
      )
        continue;
      const secondWrites = [
        ...expandedPaths(
          second,
          WORKFLOW_STEP_BY_KIND.get(second.kind)!.providedPaths,
        ),
        ...second.providedPaths,
      ].filter((path) => !path.startsWith(`steps.${second.id}.`));
      if (
        firstWrites.some((left) =>
          secondWrites.some((right) => pathsOverlap(left, right)),
        )
      )
        diagnostics.push({
          severity: "ERROR",
          code: "PARALLEL_WRITE_CONFLICT",
          message: `Parallel steps ${first.name ?? first.id} and ${second.name ?? second.id} can write the same session-data path`,
          nodeId: second.id,
        });
    }
  }
  return { definition, diagnostics };
}

export function hasWorkflowErrors(
  diagnostics: readonly WorkflowDiagnostic[],
): boolean {
  return diagnostics.some(({ severity }) => severity === "ERROR");
}
