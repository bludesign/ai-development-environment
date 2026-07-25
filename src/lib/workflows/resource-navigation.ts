import {
  preferredWorkflowResourceDestination,
  type WorkflowResourceDestination,
  type WorkflowResourceLinkLike,
} from "./resources";

type AttemptWithResourceLinks = {
  id: string;
  nodeId: string;
  kind?: string;
  generation: number;
  iterationKey: string;
  attempt: number;
  output?: unknown;
  resourceLinks: WorkflowResourceLinkLike[];
};

type RunWithResourceLinks = {
  generation: number;
  trigger?: { nodeId: string } | null;
  attempts: AttemptWithResourceLinks[];
  resourceLinks: Array<
    WorkflowResourceLinkLike & { attemptId?: string | null }
  >;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identifier(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

/**
 * Older attempts predate resource-link persistence, but their durable output
 * still contains the primary domain resource. Derive only high-confidence
 * links here so those graphs remain useful without mutating run history.
 */
function inferredAttemptResourceLink(
  attempt: AttemptWithResourceLinks,
): WorkflowResourceLinkLike | null {
  const kind = attempt.kind?.trim().toUpperCase() ?? "";
  const output = record(attempt.output);
  const value = record(output.value);
  const valuePatch = record(value.sessionPatch);
  const sessionPatch = {
    ...valuePatch,
    ...record(output.sessionPatch),
  };

  if (kind.startsWith("JIRA_")) {
    const resourceId =
      identifier(value.key) ??
      identifier(record(value.ticket).key) ??
      identifier(record(sessionPatch.ticket).key);
    return resourceId ? { kind: "JIRA_TICKET", resourceId } : null;
  }

  if (kind.startsWith("RUN_")) {
    const resourceId = identifier(value.id);
    const runKind = identifier(value.kind)?.toUpperCase();
    return resourceId && (runKind === "PLAN" || runKind === "SESSION")
      ? { kind: "AGENT_RUN", resourceId, metadata: { runKind } }
      : null;
  }

  if (kind.startsWith("WORKTREE_")) {
    const resourceId = identifier(record(sessionPatch.worktree).id);
    return resourceId ? { kind: "WORKTREE", resourceId } : null;
  }

  if (kind.startsWith("CODEBASE_")) {
    const resourceId =
      identifier(record(sessionPatch.codebase).id) ?? identifier(value.id);
    return resourceId ? { kind: "CODEBASE", resourceId } : null;
  }

  if (kind.startsWith("BUILD_")) {
    const resourceId =
      identifier(record(sessionPatch.build).id) ?? identifier(value.id);
    return resourceId ? { kind: "BUILD", resourceId } : null;
  }

  return null;
}

function sameResource(
  link: WorkflowResourceLinkLike,
  kind: string,
  resourceId: string,
): boolean {
  return (
    link.kind.trim().toUpperCase() === kind.trim().toUpperCase() &&
    link.resourceId.trim() === resourceId.trim()
  );
}

export function currentPageWorkflowNodeIds(
  run: RunWithResourceLinks,
  kind: string,
  resourceId: string,
): Set<string> {
  const result = new Set<string>();
  const attemptNodes = new Map(
    run.attempts.map((attempt) => [attempt.id, attempt.nodeId]),
  );
  for (const attempt of run.attempts) {
    if (
      attempt.resourceLinks.some((link) => sameResource(link, kind, resourceId))
    ) {
      result.add(attempt.nodeId);
    }
  }
  for (const link of run.resourceLinks) {
    if (!sameResource(link, kind, resourceId)) continue;
    const nodeId = link.attemptId
      ? attemptNodes.get(link.attemptId)
      : run.trigger?.nodeId;
    if (nodeId) result.add(nodeId);
  }
  return result;
}

/** Builds the primary click target for each action and the selected trigger. */
export function workflowRunNodeDestinations(
  run: RunWithResourceLinks,
): Map<string, WorkflowResourceDestination> {
  const result = new Map<string, WorkflowResourceDestination>();
  const attempts = [...run.attempts].sort(
    (left, right) =>
      Number(right.generation === run.generation) -
        Number(left.generation === run.generation) ||
      right.generation - left.generation ||
      right.attempt - left.attempt ||
      Number(Boolean(left.iterationKey)) - Number(Boolean(right.iterationKey)),
  );
  for (const attempt of attempts) {
    if (result.has(attempt.nodeId)) continue;
    const inferred = inferredAttemptResourceLink(attempt);
    const destination = preferredWorkflowResourceDestination(
      inferred ? [...attempt.resourceLinks, inferred] : attempt.resourceLinks,
    );
    if (destination) result.set(attempt.nodeId, destination);
  }
  const triggerDestination = preferredWorkflowResourceDestination(
    run.resourceLinks.filter(({ attemptId }) => !attemptId),
  );
  if (run.trigger?.nodeId && triggerDestination) {
    result.set(run.trigger.nodeId, triggerDestination);
  }
  return result;
}
