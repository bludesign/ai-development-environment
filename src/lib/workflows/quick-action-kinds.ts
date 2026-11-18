export const WORKFLOW_QUICK_ACTION_KINDS = [
  "STANDARD",
  "MERGE_CONFLICT",
  "FAILING_PIPELINE",
  "GITHUB_ACTIONS",
  "GITLAB_PIPELINES",
  "NONE",
] as const;

export type WorkflowQuickActionKind =
  (typeof WORKFLOW_QUICK_ACTION_KINDS)[number];
