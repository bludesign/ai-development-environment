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
  ],
  agent: [
    { name: "id", description: "Owning agent id" },
    { name: "name", description: "Agent display name" },
    { name: "hostname", description: "Agent hostname" },
    { name: "connected", description: "Whether the agent is connected" },
    { name: "diskFreeBytes", description: "Available disk space in bytes" },
    { name: "memoryFreeBytes", description: "Available memory in bytes" },
  ],
  ticket: [
    { name: "key", description: "Jira issue key (e.g. AIDE-42)" },
    { name: "projectKey", description: "Jira project key" },
    { name: "title", description: "Issue summary / title" },
    { name: "type", description: "Issue type (Bug, Story, …)" },
    { name: "status", description: "Workflow status name" },
    { name: "statusCategory", description: "Status category (To Do, Done, …)" },
    { name: "assignee", description: "Assigned user" },
    { name: "labels", description: "Issue labels" },
  ],
  pr: [
    { name: "id", description: "Pull request id" },
    { name: "number", description: "Pull request number" },
    { name: "state", description: "Open / closed / merged state" },
    { name: "title", description: "Pull request title" },
    { name: "url", description: "Pull request URL" },
    { name: "labels", description: "Pull request labels" },
    { name: "isDraft", description: "Whether the pull request is a draft" },
    { name: "headBranch", description: "Pull request head branch" },
    { name: "headSha", description: "Pull request head commit SHA" },
    { name: "baseBranch", description: "Pull request base branch" },
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
    { name: "commits", description: "Commits on the branch" },
    { name: "changes", description: "Pending file changes" },
    { name: "dirty", description: "Whether the working tree has changes" },
  ],
  pipeline: [
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
  ],
  build: [
    { name: "id", description: "Build id" },
    { name: "status", description: "Build status" },
    { name: "testSummary", description: "Test result summary" },
    { name: "coverageSummary", description: "Coverage summary" },
    { name: "artifacts", description: "Exported build artifacts" },
  ],
  run: [
    { name: "id", description: "Agent run id" },
    { name: "kind", description: "Run kind (PLAN / SESSION)" },
    { name: "status", description: "Run status" },
    { name: "phase", description: "Run phase" },
    { name: "finalOutput", description: "Final output text" },
    { name: "error", description: "Run error, if any" },
    { name: "usage", description: "Token usage and cost" },
  ],
  steps: [
    { name: "status", description: "Step completion status" },
    { name: "output", description: "Step output payload" },
    { name: "answer", description: "Human answer for the step" },
    { name: "snapshotId", description: "Captured snapshot id" },
    { name: "items", description: "Items produced for iteration" },
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
