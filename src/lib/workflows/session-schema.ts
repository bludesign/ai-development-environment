/**
 * Concrete session-data field schema.
 *
 * The workflow catalog declares step outputs and trigger seeds as wildcard
 * namespaces (`ticket.*`, `pr.*`, `steps.<id>.*`). That is enough for the
 * validator's wildcard-aware requirement checks, but it hides the concrete keys
 * a step actually contributes — so the editor can only ever suggest `ticket.*`
 * when binding a config field to session data.
 *
 * This module maps each namespace to its concrete fields (sourced from the
 * runtime normalizers in `services/workflows/register-adapters.ts` and the
 * concrete paths already referenced by the catalog) and expands wildcard paths
 * into those concrete keys with human-readable descriptions.
 *
 * Pure data + pure functions: safe to import on both the server and the client.
 */

export type SessionFieldInfo = {
  path: string;
  description?: string;
};

type NamespaceField = { name: string; description: string };

/**
 * Concrete fields per session-data namespace. When adding a step/adapter that
 * writes a new concrete path, add it here too — `session-schema.test.ts`
 * asserts every non-wildcard catalog path is represented so the two stay in
 * sync.
 */
export const SESSION_NAMESPACE_FIELDS: Record<string, NamespaceField[]> = {
  workflow: [
    { name: "id", description: "Workflow definition id" },
    { name: "name", description: "Workflow name" },
    { name: "runId", description: "Current run id" },
    { name: "startedAt", description: "Run start timestamp" },
    { name: "trigger", description: "Trigger that started the run" },
  ],
  repo: [
    { name: "id", description: "Repository id" },
    { name: "githubId", description: "GitHub repository id" },
    { name: "owner", description: "Repository owner / organization" },
    { name: "name", description: "Repository name" },
    { name: "url", description: "Repository URL" },
    { name: "canonicalOrigin", description: "Normalized repository origin" },
    { name: "displayOrigin", description: "Human-readable repository origin" },
    { name: "defaultBranch", description: "Repository default branch" },
  ],
  codebase: [
    { name: "id", description: "Codebase id" },
    { name: "agentId", description: "Owning agent id" },
    { name: "folder", description: "Codebase filesystem path" },
    { name: "branch", description: "Current branch" },
    { name: "headSha", description: "HEAD commit SHA" },
    { name: "dirty", description: "Whether the working tree has changes" },
    { name: "branches", description: "Local and remote Git branches" },
    {
      name: "branchesTruncated",
      description: "Whether branch results were truncated",
    },
    { name: "stashes", description: "Git stashes" },
    {
      name: "stashesTruncated",
      description: "Whether stash results were truncated",
    },
    { name: "remoteBranches", description: "Known remote branches" },
  ],
  agent: [
    { name: "id", description: "Owning agent id" },
    { name: "name", description: "Agent display name" },
    { name: "hostname", description: "Agent hostname" },
    { name: "connected", description: "Whether the agent is connected" },
    { name: "diskTotalBytes", description: "Root disk capacity in bytes" },
    { name: "diskFreeBytes", description: "Available disk space in bytes" },
    { name: "memoryFreeBytes", description: "Available memory in bytes" },
  ],
  disk: [
    { name: "enabled", description: "Whether disk monitoring is enabled" },
    { name: "status", description: "Current disk monitor status" },
    {
      name: "pressureMode",
      description: "Normal, manual, or automatic pressure mode",
    },
    {
      name: "manualPressureMode",
      description: "Whether manual pressure mode is enabled",
    },
    {
      name: "automaticPressureMode",
      description: "Whether automatic pressure mode is active",
    },
    {
      name: "lastReportedAt",
      description: "Timestamp of the latest accepted disk report",
    },
    { name: "lastError", description: "Latest monitor or cleanup error" },
    { name: "warnings", description: "Current disk report warnings" },
    {
      name: "monitoredVolumeId",
      description: "Least-free monitored Derived Data volume id",
    },
    { name: "freeBytes", description: "Monitored Derived Data free bytes" },
    { name: "totalBytes", description: "Monitored Derived Data total bytes" },
    {
      name: "freeGiB",
      description: "Monitored Derived Data free space in GiB",
    },
    {
      name: "freePercent",
      description: "Monitored Derived Data free percentage",
    },
    {
      name: "usedPercent",
      description: "Monitored Derived Data used percentage",
    },
    {
      name: "effectiveThresholdBytes",
      description: "Current cleanup threshold in bytes",
    },
    {
      name: "normalThresholdGiB",
      description: "Global normal threshold in GiB",
    },
    {
      name: "pressureThresholdGiB",
      description: "Global pressure threshold in GiB",
    },
    { name: "pollIntervalSeconds", description: "Agent disk report cadence" },
    {
      name: "staleAfterSeconds",
      description: "Age at which a report is stale",
    },
    {
      name: "changeReason",
      description: "Internal reason for the monitor event",
    },
    {
      name: "volumes",
      description: "All reported volumes and their monitor status",
    },
  ],
  cleanup: [
    { name: "jobId", description: "Automatic cleanup agent job id" },
    { name: "status", description: "Automatic cleanup terminal status" },
    { name: "source", description: "Cleanup source" },
    { name: "error", description: "Cleanup error, if any" },
    {
      name: "targets",
      description: "Derived Data entries selected for cleanup",
    },
    { name: "deleted", description: "Derived Data entries reported deleted" },
  ],
  command: [
    { name: "id", description: "Command run id" },
    { name: "commandId", description: "Saved command definition id" },
    { name: "name", description: "Command display name" },
    { name: "status", description: "Command run status" },
    { name: "exitCode", description: "Command process exit code" },
    { name: "signal", description: "Command termination signal" },
    { name: "error", description: "Command failure reason" },
    { name: "finishedAt", description: "Command completion timestamp" },
  ],
  skill: [
    { name: "id", description: "Skill id" },
    { name: "groupId", description: "Skill group id" },
  ],
  skillSync: [
    { name: "id", description: "Skill sync run id" },
    { name: "kind", description: "Skill sync kind" },
    { name: "status", description: "Skill sync status" },
    { name: "error", description: "Skill sync failure reason" },
    { name: "conflictCount", description: "Unresolved conflict count" },
    { name: "conflicts", description: "Unresolved skill conflicts" },
    { name: "updatedAt", description: "Skill sync update timestamp" },
    { name: "finishedAt", description: "Skill sync completion timestamp" },
  ],
  buildData: [
    { name: "id", description: "Build-data collection id" },
    { name: "status", description: "Collection status" },
    { name: "finishedAt", description: "Collection completion timestamp" },
    { name: "totalBytes", description: "Total discovered bytes" },
    { name: "entryCount", description: "Discovered entry count" },
    {
      name: "successfulAgentCount",
      description: "Agents that completed collection successfully",
    },
  ],
  signingProfile: [
    { name: "id", description: "Signing profile id" },
    { name: "uuid", description: "Provisioning profile UUID" },
    { name: "name", description: "Provisioning profile name" },
    { name: "expiresAt", description: "Provisioning profile expiry" },
    { name: "expired", description: "Whether the profile is expired" },
  ],
  device: [
    { name: "id", description: "iOS device id" },
    { name: "udid", description: "Device UDID" },
    { name: "name", description: "Device display name" },
    { name: "product", description: "Device product identifier" },
    { name: "osVersion", description: "Device OS version" },
    { name: "status", description: "Device registration status" },
    { name: "error", description: "Device registration failure reason" },
    { name: "updatedAt", description: "Device update timestamp" },
  ],
  pushBatch: [
    { name: "id", description: "Push-notification batch id" },
    { name: "status", description: "Push batch status" },
    { name: "targetMode", description: "Push batch target mode" },
    { name: "deliveryCount", description: "Push delivery count" },
    { name: "updatedAt", description: "Push batch update timestamp" },
  ],
  ticket: [
    { name: "key", description: "Jira issue key (e.g. AIDE-42)" },
    { name: "projectKey", description: "Jira project key" },
    { name: "title", description: "Issue summary / title" },
    { name: "type", description: "Issue type (Bug, Story, …)" },
    { name: "status", description: "Workflow status name" },
    { name: "statusId", description: "Workflow status id" },
    { name: "statusCategory", description: "Status category (To Do, Done, …)" },
    { name: "assignee", description: "Assigned user" },
    { name: "assigneeAccountId", description: "Assigned Jira account id" },
    { name: "labels", description: "Issue labels" },
    { name: "sprintNames", description: "Sprints containing the issue" },
    { name: "url", description: "Jira issue URL" },
  ],
  pr: [
    { name: "id", description: "Pull request id" },
    { name: "number", description: "Pull request number" },
    { name: "state", description: "Open / closed / merged state" },
    { name: "merged", description: "Whether the pull request was merged" },
    { name: "title", description: "Pull request title" },
    { name: "url", description: "Pull request URL" },
    { name: "labels", description: "Pull request labels" },
    { name: "isDraft", description: "Whether the pull request is a draft" },
    { name: "headBranch", description: "Pull request head branch" },
    { name: "headRefName", description: "Pull request head ref" },
    { name: "headSha", description: "Pull request head commit SHA" },
    { name: "baseBranch", description: "Pull request base branch" },
    { name: "reviewDecision", description: "Latest review decision" },
    {
      name: "pipelineStatus",
      description: "Combined pull request check status",
    },
    {
      name: "unresolvedReviewThreadCount",
      description: "Number of unresolved pull request review threads",
    },
    {
      name: "pipelines",
      description: "CI pipelines linked to the pull request",
    },
    { name: "reviewThreads", description: "Pull request review threads" },
    { name: "mergeable", description: "Pull request mergeability" },
    { name: "repositoryGithubId", description: "GitHub repository id" },
    {
      name: "repositoryNameWithOwner",
      description: "GitHub owner and repository name",
    },
    { name: "jiraKey", description: "Jira key linked to the pull request" },
    {
      name: "unresolvedThreads",
      description: "Unresolved review threads",
    },
  ],
  worktree: [
    { name: "id", description: "Worktree id" },
    { name: "branch", description: "Worktree branch" },
    { name: "baseBranch", description: "Base branch the work targets" },
    { name: "path", description: "Filesystem path" },
    { name: "headSha", description: "Worktree HEAD commit SHA" },
    { name: "pushStatus", description: "Push readiness status" },
    { name: "upstream", description: "Tracked upstream branch" },
    { name: "syncState", description: "Relationship to the tracked branch" },
    { name: "ahead", description: "Commits ahead of upstream" },
    { name: "behind", description: "Commits behind upstream" },
    { name: "baseAhead", description: "Commits ahead of the base branch" },
    { name: "baseBehind", description: "Commits behind the base branch" },
    { name: "commits", description: "Commits on the branch" },
    { name: "changes", description: "Pending file changes" },
    {
      name: "branchChanges",
      description: "Files changed from the base branch",
    },
    {
      name: "commitsTruncated",
      description: "Whether commit results were truncated",
    },
    {
      name: "changesTruncated",
      description: "Whether pending changes were truncated",
    },
    {
      name: "branchChangesTruncated",
      description: "Whether branch change results were truncated",
    },
    { name: "dirty", description: "Whether the working tree has changes" },
    { name: "branches", description: "Local and remote Git branches" },
    {
      name: "branchesTruncated",
      description: "Whether branch results were truncated",
    },
    { name: "stashes", description: "Git stashes" },
    {
      name: "stashesTruncated",
      description: "Whether stash results were truncated",
    },
    {
      name: "rebaseInProgress",
      description: "Whether a rebase is in progress",
    },
    { name: "hasConflicts", description: "Whether Git reports conflicts" },
    {
      name: "conflicted",
      description: "Whether an inspection found conflicts",
    },
    { name: "conflicts", description: "Conflicting files" },
    { name: "missingAt", description: "When the worktree was found missing" },
    { name: "dirtySince", description: "When the worktree became dirty" },
    {
      name: "autoSync",
      description: "Persistent Auto Sync configuration and current state",
    },
    {
      name: "autoMerge",
      description: "Persistent Auto Merge configuration and current state",
    },
  ],
  pipeline: [
    { name: "id", description: "CI pipeline id" },
    { name: "runId", description: "CI run id" },
    { name: "workflowId", description: "CI workflow id" },
    { name: "name", description: "CI workflow name" },
    { name: "displayTitle", description: "CI run display title" },
    { name: "status", description: "Run status" },
    { name: "conclusion", description: "Run conclusion" },
    { name: "headBranch", description: "Branch built by the CI run" },
    { name: "headSha", description: "Commit built by the CI run" },
    { name: "pullRequests", description: "Pull requests linked to the CI run" },
    { name: "url", description: "CI run URL" },
    { name: "failedJobs", description: "Failed jobs" },
    { name: "jobs", description: "Jobs in the CI run" },
    { name: "checkSuiteId", description: "GitHub check suite id" },
    { name: "runNumber", description: "GitHub Actions run number" },
    { name: "runAttempt", description: "GitHub Actions run attempt" },
    { name: "jiraKey", description: "Jira key inferred from the run" },
  ],
  build: [
    { name: "id", description: "Build id" },
    { name: "status", description: "Build status" },
    { name: "action", description: "Build action" },
    { name: "error", description: "Build error, if any" },
    { name: "artifactDirectory", description: "Build artifact directory" },
    { name: "testSummary", description: "Test result summary" },
    { name: "tests", description: "Individual test results" },
    { name: "coverageSummary", description: "Coverage summary" },
    { name: "coverageFiles", description: "Per-file coverage results" },
    {
      name: "changedCoverageFiles",
      description: "Coverage for files changed on the branch",
    },
    { name: "artifacts", description: "Exported build artifacts" },
    { name: "exportId", description: "Build export id" },
  ],
  run: [
    { name: "id", description: "Agent run id" },
    { name: "kind", description: "Run kind (PLAN / SESSION)" },
    { name: "status", description: "Run status" },
    { name: "phase", description: "Run phase" },
    { name: "origin", description: "Run origin" },
    { name: "provider", description: "AI provider" },
    { name: "model", description: "AI model" },
    { name: "branch", description: "Branch used by the run" },
    { name: "finalOutput", description: "Final output text" },
    { name: "error", description: "Run error, if any" },
    { name: "usage", description: "Token usage and cost" },
    { name: "questions", description: "Questions asked by the run" },
    { name: "events", description: "Run events" },
    { name: "links", description: "Resources linked to the run" },
  ],
  steps: [
    { name: "status", description: "Step completion status" },
    { name: "output", description: "Step output payload" },
    { name: "answer", description: "Human answer for the step" },
    { name: "snapshotId", description: "Captured snapshot id" },
    { name: "items", description: "Items produced for iteration" },
    { name: "commandRunId", description: "Command run id" },
    { name: "displayNumber", description: "Resource display number" },
  ],
  comment: [
    { name: "id", description: "Comment id" },
    { name: "body", description: "Comment body" },
    { name: "author", description: "Comment author" },
  ],
  push: [
    { name: "ref", description: "Pushed Git ref" },
    { name: "before", description: "Commit before the push" },
    { name: "after", description: "Commit after the push" },
  ],
  job: [
    { name: "id", description: "Job id" },
    { name: "name", description: "Job name" },
    { name: "status", description: "Job status" },
    { name: "url", description: "Job URL" },
    { name: "runAttempt", description: "Workflow run attempt" },
  ],
};

/** `{ "ticket.key": "Jira issue key …", … }` for concrete-path descriptions. */
const FIELD_DESCRIPTIONS = new Map<string, string>(
  Object.entries(SESSION_NAMESPACE_FIELDS).flatMap(([namespace, fields]) =>
    fields.map((field) => [`${namespace}.${field.name}`, field.description]),
  ),
);

function namespaceOf(path: string): string {
  return path.split(".")[0] ?? path;
}

/** Best-effort description for a concrete path, keyed by `<namespace>.<lastSegment>`. */
function describeConcretePath(path: string): string | undefined {
  const segments = path.split(".");
  if (segments.length < 2) return undefined;
  const last = segments[segments.length - 1]!;
  return FIELD_DESCRIPTIONS.get(`${namespaceOf(path)}.${last}`);
}

/**
 * Expands a set of session paths into concrete, described suggestions.
 *
 * - `ns.*` (including id-qualified prefixes like `steps.load.*` or `run.abc.*`)
 *   expands to `<prefix>.<field>` for every field in the namespace's schema.
 *   Unknown namespaces keep the wildcard verbatim.
 * - Concrete `ns.field` paths pass through, gaining a description when known.
 *
 * Results are de-duplicated by path and sorted for stable rendering.
 */
export function expandSessionPaths(
  paths: readonly string[],
): SessionFieldInfo[] {
  const byPath = new Map<string, SessionFieldInfo>();
  const add = (info: SessionFieldInfo) => {
    if (!byPath.has(info.path)) byPath.set(info.path, info);
  };

  for (const raw of paths) {
    const path = raw.trim();
    if (!path || path === "*") continue;
    if (path.endsWith(".*")) {
      const prefix = path.slice(0, -2);
      const fields = SESSION_NAMESPACE_FIELDS[namespaceOf(prefix)];
      if (fields) {
        for (const field of fields)
          add({
            path: `${prefix}.${field.name}`,
            description: field.description,
          });
      } else {
        add({ path });
      }
      continue;
    }
    add({ path, description: describeConcretePath(path) });
  }

  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}
