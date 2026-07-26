import type {
  GitHubPipelineObservationSource,
  GitHubPipelineState,
  GitHubPipelineStatus,
} from "./types";

export const GITHUB_PIPELINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const GITHUB_PIPELINE_OPTIMISTIC_MS = 2 * 60 * 1_000;

const SOURCE_PRIORITY: Record<GitHubPipelineObservationSource, number> = {
  LEGACY: 0,
  GRAPHQL: 1,
  REST: 2,
  WEBHOOK: 3,
  MUTATION: 4,
};

const FAILURE_STATES = new Set<GitHubPipelineState>([
  "CANCELLED",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const PENDING_STATES = new Set<GitHubPipelineState>([
  "ACTION_REQUIRED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
]);
const SUCCESS_STATES = new Set<GitHubPipelineState>([
  "SUCCESS",
  "NEUTRAL",
  "SKIPPED",
]);

export function aggregatePipelineStatus(
  states: GitHubPipelineState[],
  graphqlRollupStatus: GitHubPipelineStatus | null = null,
): GitHubPipelineStatus {
  if (states.some((state) => state === "ERROR")) return "ERROR";
  if (states.some((state) => FAILURE_STATES.has(state))) return "FAILURE";
  if (states.some((state) => PENDING_STATES.has(state))) return "PENDING";
  if (
    states.some((state) => state === "EXPECTED") ||
    graphqlRollupStatus === "EXPECTED"
  ) {
    return "EXPECTED";
  }
  if (states.length > 0 && states.every((state) => SUCCESS_STATES.has(state))) {
    return "SUCCESS";
  }
  if (states.length === 0 && graphqlRollupStatus) return graphqlRollupStatus;
  return "NONE";
}

export function normalizePipelineState(
  status: string | null | undefined,
  conclusion?: string | null,
): GitHubPipelineState {
  const value = (conclusion || status || "NONE").toUpperCase();
  if (isPipelineState(value)) return value;
  if (value === "REQUESTED" || value === "WAITING") return "QUEUED";
  if (value === "COMPLETED") return "NONE";
  return "NONE";
}

export function pipelineIdentity(input: {
  checkSuiteId?: string | null;
  workflowRunId?: string | null;
  statusContext?: string | null;
  id: string;
}): string {
  if (input.checkSuiteId) return `CHECK_SUITE:${input.checkSuiteId}`;
  if (input.workflowRunId) return `WORKFLOW_RUN:${input.workflowRunId}`;
  if (input.statusContext) return `STATUS_CONTEXT:${input.statusContext}`;
  return `PIPELINE:${input.id}`;
}

export type MergeComparable = {
  runAttempt: number | null;
  githubUpdatedAt: Date | null;
  source: GitHubPipelineObservationSource;
  optimisticUntil: Date | null;
};

export function shouldReplacePipelineRecord(
  current: MergeComparable,
  incoming: Omit<MergeComparable, "optimisticUntil">,
  now: Date,
): boolean {
  const currentAttempt = current.runAttempt ?? 0;
  const incomingAttempt = incoming.runAttempt ?? 0;
  if (incomingAttempt !== currentAttempt)
    return incomingAttempt > currentAttempt;

  const currentTimestamp = current.githubUpdatedAt?.getTime() ?? 0;
  const incomingTimestamp = incoming.githubUpdatedAt?.getTime() ?? 0;
  if (incomingTimestamp !== currentTimestamp) {
    return incomingTimestamp > currentTimestamp;
  }

  if (
    current.source === "MUTATION" &&
    current.optimisticUntil &&
    current.optimisticUntil.getTime() > now.getTime()
  ) {
    return incoming.source === "MUTATION";
  }
  const currentPriority =
    current.source === "MUTATION"
      ? SOURCE_PRIORITY.LEGACY
      : SOURCE_PRIORITY[current.source];
  return SOURCE_PRIORITY[incoming.source] >= currentPriority;
}

export function isPipelineState(value: string): value is GitHubPipelineState {
  return (
    value === "ACTION_REQUIRED" ||
    value === "CANCELLED" ||
    value === "ERROR" ||
    value === "EXPECTED" ||
    value === "FAILURE" ||
    value === "IN_PROGRESS" ||
    value === "NEUTRAL" ||
    value === "PENDING" ||
    value === "QUEUED" ||
    value === "SKIPPED" ||
    value === "STALE" ||
    value === "STARTUP_FAILURE" ||
    value === "SUCCESS" ||
    value === "TIMED_OUT" ||
    value === "NONE"
  );
}

export function isPipelineStatus(value: string): value is GitHubPipelineStatus {
  return (
    value === "ERROR" ||
    value === "EXPECTED" ||
    value === "FAILURE" ||
    value === "PENDING" ||
    value === "SUCCESS" ||
    value === "NONE"
  );
}
