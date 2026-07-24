import {
  preferredWorkflowResourceDestination,
  type WorkflowResourceDestination,
  type WorkflowResourceLinkLike,
} from "./resources";

type AttemptWithResourceLinks = {
  id: string;
  nodeId: string;
  generation: number;
  iterationKey: string;
  attempt: number;
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
    const destination = preferredWorkflowResourceDestination(
      attempt.resourceLinks,
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
