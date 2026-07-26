import { isResourceTriggerKind } from "./definition";

export function pullRequestResourceId(
  owner: string,
  repository: string,
  number: number,
): string {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedRepository = repository.trim().toLowerCase();
  if (!normalizedOwner || !normalizedRepository) {
    throw new Error("Pull request repository coordinates are required");
  }
  if (!Number.isInteger(number) || number < 1) {
    throw new Error("Pull request number must be a positive integer");
  }
  return `${normalizedOwner}/${normalizedRepository}#${number}`;
}

export function githubPipelineResourceId(
  codebaseRepositoryId: string,
  workflowRunId: string | null | undefined,
  pipelineId: string,
): string {
  const repositoryId = codebaseRepositoryId.trim();
  const runId = workflowRunId?.trim();
  const fallbackId = pipelineId.trim();
  if (!repositoryId || (!runId && !fallbackId)) {
    throw new Error("GitHub pipeline repository and provider ID are required");
  }
  return `${repositoryId}:${runId ? "run" : "check"}:${runId || fallbackId}`;
}

export function githubJobResourceId(
  codebaseRepositoryId: string,
  jobId: string,
): string {
  const repositoryId = codebaseRepositoryId.trim();
  const normalizedJobId = jobId.trim();
  if (!repositoryId || !normalizedJobId) {
    throw new Error("GitHub job repository and job ID are required");
  }
  return `${repositoryId}:job:${normalizedJobId}`;
}

export type WorkflowResourceLinkLike = {
  kind: string;
  resourceId: string;
  label?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date | null;
};

export type WorkflowResourceDestination = {
  href: string;
  external: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nested(
  value: Record<string, unknown>,
  parent: string,
  child: string,
): unknown {
  return record(value[parent])[child];
}

function repositoryCoordinates(value: unknown): {
  owner: string;
  repository: string;
} | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const match =
    normalized.match(
      /(?:https?:\/\/|ssh:\/\/git@|git@)?github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i,
    ) ?? normalized.match(/^([^/:]+)\/([^/#]+?)(?:\.git)?$/);
  return match?.[1] && match[2]
    ? { owner: match[1], repository: match[2] }
    : null;
}

function resourceLink(
  kind: string,
  resourceId: unknown,
  options: Pick<WorkflowResourceLinkLike, "label" | "url" | "metadata"> = {},
): WorkflowResourceLinkLike | null {
  if (typeof resourceId !== "string" && typeof resourceId !== "number")
    return null;
  const id = String(resourceId).trim();
  return id ? { kind, resourceId: id, ...options } : null;
}

const jiraTriggerKinds = new Set([
  "JIRA_STATUS",
  "JIRA_LABEL",
  "JIRA_ASSIGNED_SELF",
  "JIRA_SOURCE_NEW_TICKET",
  "JIRA_MENTION",
  "JIRA_SPRINT_STARTED",
]);
const runTriggerKinds = new Set([
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
]);
const buildTriggerKinds = new Set([
  "BUILD_RESULT",
  "BUILD_TEST_THRESHOLD",
  "BUILD_COVERAGE_THRESHOLD",
  "BUILD_HOOK_FAILED",
]);
const worktreeTriggerKinds = new Set([
  "WORKTREE_CREATED",
  "WORKTREE_BEHIND",
  "WORKTREE_CONFLICT",
  "WORKTREE_MISSING",
  "WORKTREE_DIVERGED",
  "WORKTREE_DIRTY_DURATION",
  "WORKTREE_NEW_COMMIT",
]);
const pullRequestTriggerKinds = new Set([
  "GITHUB_PR_STATE",
  "GITHUB_REVIEW_CHANGES_REQUESTED",
  "GITHUB_REVIEW_COMMENT",
  "GITHUB_PR_CLOSED",
  "GITHUB_ISSUE_COMMAND",
  "GITHUB_PR_LABEL",
]);
const workflowRunTriggerKinds = new Set([
  "GITHUB_CHECK_FAILED",
  "GITHUB_WORKFLOW_SUCCEEDED",
  "GITHUB_ACTIONS_RESULT",
]);

/** Returns the primary resource that caused a workflow trigger event. */
export function workflowTriggerResourceLink(
  triggerKind: string,
  payload: Record<string, unknown>,
): WorkflowResourceLinkLike | null {
  const kind = triggerKind.trim().toUpperCase();
  const session = record(payload.sessionData);
  if (isResourceTriggerKind(kind)) {
    const resourceKind = payload.resourceKind;
    const normalizedResourceKind =
      typeof resourceKind === "string" ? resourceKind.toUpperCase() : null;
    const providerUrl =
      normalizedResourceKind === "GITHUB_JOB"
        ? nested(session, "job", "url")
        : normalizedResourceKind === "GITHUB_PIPELINE"
          ? nested(session, "pipeline", "url")
          : null;
    return typeof resourceKind === "string"
      ? resourceLink(resourceKind.toUpperCase(), payload.resourceId, {
          url: typeof providerUrl === "string" ? providerUrl : null,
          metadata:
            resourceKind.toUpperCase() === "AGENT_RUN"
              ? { runKind: nested(session, "run", "kind") }
              : null,
        })
      : null;
  }
  if (jiraTriggerKinds.has(kind)) {
    return resourceLink("JIRA_TICKET", nested(session, "ticket", "key"));
  }
  if (runTriggerKinds.has(kind)) {
    return resourceLink("AGENT_RUN", nested(session, "run", "id"), {
      metadata: { runKind: nested(session, "run", "kind") },
    });
  }
  if (buildTriggerKinds.has(kind)) {
    return resourceLink("BUILD", nested(session, "build", "id"));
  }
  if (worktreeTriggerKinds.has(kind)) {
    return resourceLink("WORKTREE", nested(session, "worktree", "id"));
  }
  if (kind === "CODEBASE_REMOTE_BRANCH") {
    return resourceLink("CODEBASE", nested(session, "codebase", "id"));
  }
  if (kind === "AGENT_JOB_FAILED") {
    return resourceLink(
      "AGENT_JOB",
      nested(record(session.steps), "trigger", "id"),
    );
  }
  if (
    kind === "AGENT_CONNECTION" ||
    kind === "AGENT_DISK_REPORT" ||
    kind === "AGENT_DISK_THRESHOLD" ||
    kind === "AGENT_DISK_STATE_CHANGED" ||
    kind === "AGENT_DISK_CLEANUP_RESULT" ||
    kind === "CCUSAGE_THRESHOLD"
  ) {
    return resourceLink(
      "AGENT",
      nested(session, "agent", "id") ?? nested(session, "codebase", "agentId"),
    );
  }
  if (kind === "WORKFLOW_FINISHED") {
    return resourceLink("WORKFLOW_RUN", nested(payload, "run", "id"));
  }
  if (pullRequestTriggerKinds.has(kind)) {
    const coordinates = repositoryCoordinates(
      nested(session, "repo", "displayOrigin"),
    );
    const number = Number(nested(session, "pr", "number"));
    return coordinates && Number.isInteger(number) && number > 0
      ? resourceLink(
          "PULL_REQUEST",
          pullRequestResourceId(
            coordinates.owner,
            coordinates.repository,
            number,
          ),
        )
      : null;
  }
  if (workflowRunTriggerKinds.has(kind)) {
    const providerUrl = nested(session, "pipeline", "url");
    return resourceLink(
      "GITHUB_WORKFLOW_RUN",
      nested(session, "pipeline", "runId"),
      { url: typeof providerUrl === "string" ? providerUrl : null },
    );
  }
  if (kind === "GITHUB_PUSH_DEFAULT") {
    return resourceLink("CODEBASE_REPOSITORY", nested(session, "repo", "id"));
  }
  return null;
}

function segment(value: string): string {
  return encodeURIComponent(value.trim());
}

function internalUrl(value: string | null | undefined): string | null {
  if (!value?.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

function externalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return new Set(["http:", "https:"]).has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function pullRequestHref(resourceId: string): string | null {
  const separator = resourceId.lastIndexOf("#");
  if (separator < 1) return null;
  const repository = resourceId.slice(0, separator);
  const slash = repository.indexOf("/");
  if (slash < 1 || slash === repository.length - 1) return null;
  const number = Number(resourceId.slice(separator + 1));
  if (!Number.isInteger(number) || number < 1) return null;
  return `/pull-requests/${segment(repository.slice(0, slash))}/${segment(repository.slice(slash + 1))}/${number}`;
}

/**
 * Resolves workflow resource links to the most specific page the control plane
 * knows how to open. Explicit app routes win over derived routes; provider URLs
 * are only used when the app has no detail route for the resource.
 */
export function workflowResourceDestination(
  link: WorkflowResourceLinkLike,
): WorkflowResourceDestination | null {
  const explicitInternal = internalUrl(link.url);
  if (explicitInternal) return { href: explicitInternal, external: false };

  const kind = link.kind.trim().toUpperCase();
  const id = link.resourceId.trim();
  if (!id) return null;
  const runKind =
    typeof link.metadata?.runKind === "string"
      ? link.metadata.runKind.toUpperCase()
      : null;
  const derived =
    kind === "BUILD"
      ? `/builds/${segment(id)}`
      : kind === "CODEBASE"
        ? `/codebases/${segment(id)}`
        : kind === "JIRA_TICKET"
          ? `/jira/tickets/${segment(id)}`
          : kind === "WORKTREE"
            ? `/worktrees/${segment(id)}`
            : kind === "AGENT_RUN" && runKind === "PLAN"
              ? `/plans/${segment(id)}`
              : kind === "AGENT_RUN" && runKind === "SESSION"
                ? `/sessions/${segment(id)}`
                : kind === "PULL_REQUEST"
                  ? pullRequestHref(id)
                  : kind === "AGENT_JOB"
                    ? `/jobs/${segment(id)}`
                    : kind === "COMMAND_RUN"
                      ? `/commands/runs/${segment(id)}`
                      : kind === "WORKFLOW_RUN"
                        ? `/workflows/runs/${segment(id)}`
                        : kind === "SKILL_RUN"
                          ? `/skills/sync/${segment(id)}`
                          : kind === "AGENT"
                            ? `/agents/${segment(id)}`
                            : kind === "CODEBASE_REPOSITORY"
                              ? `/codebases/repositories/${segment(id)}`
                              : null;
  if (derived) return { href: derived, external: false };

  const provider = externalUrl(link.url);
  return provider ? { href: provider, external: true } : null;
}

function navigationPriority(link: WorkflowResourceLinkLike): number {
  const kind = link.kind.trim().toUpperCase();
  if (kind === "AGENT_JOB") return 30;
  if (kind === "COMMAND_RUN") return 30;
  if (kind === "GITHUB_WORKFLOW_RUN") return 20;
  return 10;
}

/** Selects one predictable click target when an attempt recorded many links. */
export function preferredWorkflowResourceDestination(
  links: readonly WorkflowResourceLinkLike[],
): WorkflowResourceDestination | null {
  return (
    links
      .map((link, index) => ({
        destination: workflowResourceDestination(link),
        index,
        link,
        time:
          link.createdAt instanceof Date
            ? link.createdAt.getTime()
            : Date.parse(link.createdAt ?? "") || 0,
      }))
      .filter(
        (
          entry,
        ): entry is typeof entry & {
          destination: WorkflowResourceDestination;
        } => entry.destination !== null,
      )
      .sort(
        (left, right) =>
          navigationPriority(left.link) - navigationPriority(right.link) ||
          right.time - left.time ||
          right.index - left.index,
      )[0]?.destination ?? null
  );
}
