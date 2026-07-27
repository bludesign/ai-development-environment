import { randomBytes, randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import { CREDENTIALS, CredentialService } from "@/services/credentials";
import {
  cancelGitHubActionsWorkflow,
  clearGitHubAppTokenCache,
  configureGitHubAppWebhook,
  getGitHubAppRegistration,
  githubAppGraphql,
  GitHubAppError,
  listGitHubActionsWorkflowJobs,
  type GitHubActionsWorkflowJob,
  type GitHubAppCredentials,
  rerunGitHubActionsJob,
  rerunGitHubActionsFailedJobs,
  rerunGitHubActionsWorkflow,
  verifyGitHubAppConfiguration,
} from "@/server/github/github-app";

import type {
  GitHubApiCallFilters,
  GitHubApiCallView,
  GitHubActionsRepositoryErrorView,
  GitHubActionsRepositoryView,
  GitHubActionsWorkflowRunPage,
  GitHubActionsWorkflowRunView,
  GitHubAutoRetryRuleView,
  GitHubAppSettingsView,
  GitHubAuditContext,
  GitHubCachedEntryDetail,
  GitHubCachedEntryView,
  GitHubCacheMetrics,
  GitHubCacheTtlOverrideView,
  GitHubPipelineState,
  GitHubPipelineStatus,
  GitHubPipelineView,
  GitHubMergeMethod,
  GitHubPaginatedResult,
  GitHubPullRequestDetail,
  GitHubPullRequestLiveStatus,
  GitHubPullRequestMergeOptions,
  GitHubPullRequestMergeResult,
  GitHubPullRequestPage,
  GitHubPullRequestScope,
  GitHubPullRequestState,
  GitHubPullRequestStateFilter,
  GitHubPullRequestView,
  GitHubReviewComment,
  GitHubRepositoryCandidatePage,
  GitHubRepositoryWorkflowView,
  GitHubRepositoryView,
  GitHubReviewDecision,
  GitHubReviewThread,
  GitHubReviewThreadPage,
  GitHubReviewThreadPullRequest,
  GitHubReviewThreadState,
  GitHubRateLimitSnapshotView,
  GitHubRequestSource,
  GitHubSettingsView,
  GitHubViewer,
  GitHubWebhookDeliveryPage,
  GitHubWorkflowJobView,
  GitHubWorkflowRunAttemptView,
  SaveGitHubAutoRetryRuleInput,
} from "./types";
import { GitHubAutoRetryService } from "./github-auto-retry.service";
import {
  GitHubPipelineStatusService,
  type GitHubPipelineObservation,
} from "./github-pipeline-status.service";
import { normalizePipelineState } from "./pipeline-status";
import type { PollingService } from "@/services/polling";
import { GitHubCache } from "./github-cache";
import { GITHUB_API_BASE_URL, GITHUB_GRAPHQL_URL } from "./github-endpoints";
import {
  extractGitHubGraphqlCost,
  prepareGitHubGraphql,
} from "./github-graphql";
import {
  GITHUB_REST_OPERATIONS,
  type GitHubRestOperation,
} from "./github-rest-operations";
import {
  listGitHubRateLimitSnapshots,
  observeGitHubRateLimit,
  type GitHubRateLimitMetadata,
} from "./github-rate-limit";

const SETTINGS_ID = "default";
const GITHUB_APP_SETTINGS_ID = "default";
const SEARCH_RESULT_LIMIT = 1000;
const ACTIONS_PAGE_SIZE = 25;
const PULL_REQUEST_PAGE_SIZE = 25;
export const MIN_ACTIONS_NOTIFICATION_POLL_INTERVAL_SECONDS = 30;
export const MAX_ACTIONS_NOTIFICATION_POLL_INTERVAL_SECONDS = 3_600;
export const DEFAULT_JIRA_KEY_REGEX = String.raw`\b([A-Z][A-Z0-9_]*-\d+)\b`;

const ENHANCED_PIPELINE_WEBHOOK_EVENTS = [
  "workflow_run",
  "workflow_job",
  "check_run",
  "check_suite",
  "status",
] as const;

function jsonStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function permissionCanRead(value: string | null): boolean {
  return value === "read" || value === "write";
}

function enhancedPipelineWebhookRequirements(input: {
  webhookConfigured: boolean;
  actionsPermission: string | null;
  checksPermission: string | null;
  commitStatusesPermission: string | null;
  webhookEvents: string[];
}): string[] {
  const missing: string[] = [];
  if (!input.webhookConfigured)
    missing.push("configure the signed webhook URL");
  if (!permissionCanRead(input.actionsPermission)) {
    missing.push("grant Actions read permission");
  }
  if (!permissionCanRead(input.checksPermission)) {
    missing.push("grant Checks read permission");
  }
  if (!permissionCanRead(input.commitStatusesPermission)) {
    missing.push("grant Commit statuses read permission");
  }
  for (const event of ENHANCED_PIPELINE_WEBHOOK_EVENTS) {
    if (!input.webhookEvents.includes(event)) {
      missing.push(`subscribe to the ${event} event`);
    }
  }
  return missing;
}

function requestSourceFromAudit(
  context: GitHubAuditContext,
): GitHubRequestSource {
  if (context.actor === "auto-retry") return "AUTO_RETRY";
  if (context.actor === "workflow") return "WORKFLOW_AUTOMATION";
  return "ACTIONS_PAGE";
}

type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type RawConnection<T> = {
  nodes: Array<T | null> | null;
  pageInfo: PageInfo;
};

type RawPullRequest = {
  id: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  state: GitHubPullRequestState;
  mergedAt: string | null;
  headRefName: string;
  headRepository: { nameWithOwner: string } | null;
  repository: {
    id: string;
    nameWithOwner: string;
    url: string;
  };
  labels: RawConnection<{ name: string }>;
  statusCheckRollup: {
    state: string;
    contexts: RawConnection<RawPipelineContext>;
  } | null;
  reviewDecision: string | null;
  reviewThreads: RawConnection<{ isResolved: boolean }>;
  isDraft: boolean;
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
  mergeStateStatus: string;
  autoMergeRequest: { enabledAt: string } | null;
  viewerCanEnableAutoMerge: boolean;
  viewerCanDisableAutoMerge: boolean;
  headRefOid: string;
};

type RawPullRequestLiveStatus = Pick<
  RawPullRequest,
  | "id"
  | "state"
  | "mergedAt"
  | "statusCheckRollup"
  | "reviewDecision"
  | "reviewThreads"
  | "isDraft"
  | "mergeable"
  | "mergeStateStatus"
  | "autoMergeRequest"
  | "viewerCanEnableAutoMerge"
  | "viewerCanDisableAutoMerge"
  | "headRefOid"
  | "updatedAt"
  | "repository"
>;

type GitHubQueryOptions = {
  force?: boolean;
  allowStaleOnError?: boolean;
  requestSource?: GitHubRequestSource;
};

type RawCheckSuite = {
  id: string;
  status: string;
  conclusion: string | null;
  url: string;
  app: { name: string; slug: string } | null;
  workflowRun: {
    databaseId: string | number;
    url: string;
    runNumber: number;
    runAttempt: number;
    updatedAt: string;
    workflow: { name: string };
  } | null;
};

type RawRetryCheckSuite = RawCheckSuite & {
  repository: {
    id: string;
    name: string;
    owner: { login: string };
  };
};

type RawActionsWorkflowRun = {
  id: string | number;
  workflow_id?: string | number;
  name: string | null;
  display_title: string;
  run_number: number;
  run_attempt: number | null;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  check_suite_node_id: string | null;
  repository: {
    node_id: string;
    full_name: string;
    html_url: string;
  };
  pull_requests: Array<{ number: number }>;
  run_started_at: string | null;
  created_at: string;
  updated_at: string;
  actor?: RawWorkflowRunActor | null;
  triggering_actor?: RawWorkflowRunActor | null;
};

type RawWorkflowRunActor = {
  login: string;
  avatar_url: string;
  html_url: string;
};

type RawRepositoryWorkflow = {
  id: string | number;
  name: string;
  path: string;
  state: string;
  html_url: string;
};

type ActionsRepositoryTarget = GitHubActionsRepositoryView & {
  owner: string;
  name: string;
  jiraBranchRegex: string | null;
};

type ActionsCursor = {
  version: 1;
  codebaseRepositoryId: string | null;
  branch: string | null;
  workflowId: string | null;
  consumed: Record<string, number>;
};

type PullRequestCursorStream = {
  after: string | null;
  offset: number;
  consumed: number;
  exhausted: boolean;
  limitReached: boolean;
};

type PullRequestCursor = {
  version: 1;
  scope: GitHubPullRequestScope;
  repositoryId: string | null;
  state: GitHubPullRequestStateFilter;
  streams: Record<string, PullRequestCursorStream>;
};

type RawPipelineContext =
  | {
      __typename: "CheckRun";
      id: string;
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      startedAt: string | null;
      completedAt: string | null;
      checkSuite: RawCheckSuite;
    }
  | {
      __typename: "StatusContext";
      id: string;
      context: string;
      state: string;
      description: string | null;
      targetUrl: string | null;
      updatedAt: string;
    };

type RawPullRequestDetail = Omit<RawPullRequest, "reviewThreads"> & {
  body: string;
  bodyHTML: string;
  author: { login: string; avatarUrl: string; url: string } | null;
  assignees: RawConnection<{ login: string; avatarUrl: string; url: string }>;
  reviewThreads: RawConnection<RawReviewThread>;
  baseRefName: string;
  headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: { totalCount: number };
  mergedAt: string | null;
};

type RawPullRequestMergeState = {
  id: string;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
  mergeStateStatus: string;
  headRefOid: string;
  headRefName: string;
  headRepository: { nameWithOwner: string } | null;
  mergedAt: string | null;
  autoMergeRequest: { enabledAt: string } | null;
  viewerCanEnableAutoMerge: boolean;
  viewerCanDisableAutoMerge: boolean;
};

type RepositoryPermission = "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE" | "READ";

type RawActor = {
  login: string;
  avatarUrl: string;
  url: string;
};

type RawReviewComment = {
  id: string;
  body: string;
  bodyText: string;
  bodyHTML: string;
  url: string;
  author: RawActor | null;
  createdAt: string;
  updatedAt: string;
  replyTo: { id: string } | null;
};

type RawReviewThreadPullRequest = {
  id: string;
  number: number;
  title: string;
  url: string;
  headRefName: string;
  headRepository: { nameWithOwner: string } | null;
  repository: { nameWithOwner: string };
};

type RawReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  subjectType: "FILE" | "LINE";
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  resolvedBy: RawActor | null;
  pullRequest: RawReviewThreadPullRequest;
  comments: RawConnection<RawReviewComment>;
};

type RawReviewPullRequestMetadata = RawReviewThreadPullRequest & {
  updatedAt: string;
};

type RawReviewPullRequest = RawReviewPullRequestMetadata & {
  reviewThreads: RawConnection<RawReviewThread>;
};

type GitHubResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

class GitHubRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly rateLimit: GitHubRateLimitMetadata | null,
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

const PIPELINE_CONTEXT_FIELDS = `
  __typename
  ... on CheckRun {
    id
    name
    status
    conclusion
    detailsUrl
    startedAt
    completedAt
    checkSuite {
      id
      status
      conclusion
      url
      app { name slug }
      workflowRun {
        databaseId
        url
        runNumber
        runAttempt
        updatedAt
        workflow { name }
      }
    }
  }
  ... on StatusContext {
    id
    context
    state
    description
    targetUrl
    updatedAt
  }
`;

const PULL_REQUEST_BASE_FIELDS = `
    id
    number
    title
    url
    createdAt
    updatedAt
    state
    mergedAt
    headRefName
    headRefOid
    headRepository { nameWithOwner }
    repository { id nameWithOwner url }
    labels(first: 100) {
      nodes { name }
      pageInfo { hasNextPage endCursor }
    }
    statusCheckRollup {
      state
      contexts(first: 100) {
        nodes { ${PIPELINE_CONTEXT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
    reviewDecision
    isDraft
    mergeable
    mergeStateStatus
    autoMergeRequest { enabledAt }
    viewerCanEnableAutoMerge
    viewerCanDisableAutoMerge
`;

const PULL_REQUEST_FRAGMENT = `
  fragment PullRequestTableFields on PullRequest {
    ${PULL_REQUEST_BASE_FIELDS}
    reviewThreads(first: 100) {
      nodes { isResolved }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PULL_REQUEST_LIVE_FRAGMENT = `
  fragment PullRequestLiveFields on PullRequest {
    id
    updatedAt
    state
    mergedAt
    headRefOid
    repository { id nameWithOwner url }
    statusCheckRollup {
      state
      contexts(first: 100) {
        nodes { ${PIPELINE_CONTEXT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
    reviewDecision
    reviewThreads(first: 100) {
      nodes { isResolved }
      pageInfo { hasNextPage endCursor }
    }
    isDraft
    mergeable
    mergeStateStatus
    autoMergeRequest { enabledAt }
    viewerCanEnableAutoMerge
    viewerCanDisableAutoMerge
  }
`;

const REVIEW_COMMENT_FIELDS = `
  id
  body
  bodyText
  bodyHTML
  url
  author { login avatarUrl url }
  createdAt
  updatedAt
  replyTo { id }
`;

const REVIEW_THREAD_FIELDS = `
  id
  isResolved
  isOutdated
  subjectType
  path
  line
  startLine
  originalLine
  originalStartLine
  viewerCanReply
  viewerCanResolve
  viewerCanUnresolve
  resolvedBy { login avatarUrl url }
  pullRequest {
    id
    number
    title
    url
    headRefName
    headRepository { nameWithOwner }
    repository { nameWithOwner }
  }
  comments(first: 100) {
    nodes { ${REVIEW_COMMENT_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
`;

const PULL_REQUEST_DETAIL_FRAGMENT = `
  fragment PullRequestDetailFields on PullRequest {
    ${PULL_REQUEST_BASE_FIELDS}
    reviewThreads(first: 100) {
      nodes { ${REVIEW_THREAD_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type WorktreeHighlight = { id: string; highlightColor: string | null };

const worktreeHighlightKey = (canonicalOrigin: string, branch: string) =>
  `${canonicalOrigin}\u0000${branch}`;

const canonicalOriginOf = (nameWithOwner: string) =>
  `github.com/${nameWithOwner.toLowerCase()}`;

/** A pull request branch can only match a worktree when GitHub identifies the
 * repository that owns the head ref. */
const headRepositoryName = (pullRequest: {
  headRepository: { nameWithOwner: string } | null;
}) => pullRequest.headRepository?.nameWithOwner ?? null;

function pullRequestWorktreeHighlight(
  pullRequest: {
    headRefName: string;
    headRepository: { nameWithOwner: string } | null;
  },
  highlights?: Map<string, WorktreeHighlight>,
) {
  const nameWithOwner = headRepositoryName(pullRequest);
  return nameWithOwner
    ? highlights?.get(
        worktreeHighlightKey(
          canonicalOriginOf(nameWithOwner),
          pullRequest.headRefName,
        ),
      )
    : undefined;
}

function repositoryView(repository: {
  id: string;
  githubId: string;
  owner: string;
  name: string;
  nameWithOwner: string;
  url: string;
  jiraKeyRegex: string | null;
}): GitHubRepositoryView {
  return {
    id: repository.id,
    githubId: repository.githubId,
    owner: repository.owner,
    name: repository.name,
    nameWithOwner: repository.nameWithOwner,
    url: repository.url,
    jiraKeyRegex: repository.jiraKeyRegex,
  };
}

function connectionNodes<T>(connection: RawConnection<T>): T[] {
  return (connection.nodes ?? []).filter((node): node is T => node !== null);
}

function sanitizeError(message: string, token: string): string {
  return message.split(token).join("[REDACTED]");
}

export function normalizeGitHubRepositoryName(value: string): {
  owner: string;
  name: string;
} {
  const parts = value.trim().split("/");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[1])
  ) {
    throw new Error("Repository must use the owner/name format");
  }
  return { owner: parts[0], name: parts[1] };
}

export function normalizeJiraKeyRegex(
  value: string | null | undefined,
): string | null {
  const pattern = value?.trim() ?? "";
  if (!pattern) return null;
  try {
    void new RegExp(pattern, "i");
  } catch {
    throw new Error("Jira key regex is invalid");
  }
  return pattern;
}

export function parseJiraKey(
  title: string,
  pattern: string | null,
): string | null {
  if (!pattern) return null;
  const match = new RegExp(pattern, "i").exec(title);
  const value = (match?.[1] ?? match?.[0])?.trim();
  return value ? value.toUpperCase() : null;
}

function actionsRepositoryTarget(repository: {
  id: string;
  canonicalOrigin: string;
  jiraBranchRegex: string | null;
}): ActionsRepositoryTarget | null {
  const match = /^github\.com\/([^/]+)\/([^/]+)$/i.exec(
    repository.canonicalOrigin.trim(),
  );
  if (!match?.[1] || !match[2]) return null;
  const owner = match[1];
  const name = match[2];
  const nameWithOwner = `${owner}/${name}`;
  return {
    id: repository.id,
    owner,
    name,
    nameWithOwner,
    url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    jiraBranchRegex: repository.jiraBranchRegex,
  };
}

function decodeActionsCursor(
  value: string | null | undefined,
  codebaseRepositoryId: string | null,
  branch: string | null,
  workflowId: string | null,
): ActionsCursor {
  if (!value) {
    return {
      version: 1,
      codebaseRepositoryId,
      branch,
      workflowId,
      consumed: {},
    };
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ActionsCursor>;
    if (
      parsed.version !== 1 ||
      parsed.codebaseRepositoryId !== codebaseRepositoryId ||
      parsed.branch !== branch ||
      parsed.workflowId !== workflowId ||
      !parsed.consumed ||
      typeof parsed.consumed !== "object" ||
      Object.values(parsed.consumed).some(
        (item) => !Number.isInteger(item) || Number(item) < 0,
      )
    ) {
      throw new Error("invalid");
    }
    return parsed as ActionsCursor;
  } catch {
    throw new Error("GitHub Actions pagination cursor is invalid");
  }
}

function encodeActionsCursor(cursor: ActionsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function pullRequestCursorStreamKeys(scope: GitHubPullRequestScope): string[] {
  if (scope === "MINE") return ["assigned", "authored"];
  if (scope === "REVIEW_REQUESTED") return ["review"];
  return ["repository"];
}

function emptyPullRequestCursorStream(): PullRequestCursorStream {
  return {
    after: null,
    offset: 0,
    consumed: 0,
    exhausted: false,
    limitReached: false,
  };
}

function decodePullRequestCursor(
  value: string | null | undefined,
  scope: GitHubPullRequestScope,
  repositoryId: string | null,
  state: GitHubPullRequestStateFilter,
): PullRequestCursor {
  const expectedKeys = pullRequestCursorStreamKeys(scope);
  if (!value) {
    return {
      version: 1,
      scope,
      repositoryId,
      state,
      streams: Object.fromEntries(
        expectedKeys.map((key) => [key, emptyPullRequestCursorStream()]),
      ),
    };
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<PullRequestCursor>;
    if (
      parsed.version !== 1 ||
      parsed.scope !== scope ||
      parsed.repositoryId !== repositoryId ||
      parsed.state !== state ||
      !parsed.streams ||
      typeof parsed.streams !== "object" ||
      Object.keys(parsed.streams).sort().join("\0") !==
        [...expectedKeys].sort().join("\0")
    ) {
      throw new Error("invalid");
    }
    for (const stream of Object.values(parsed.streams)) {
      if (
        !stream ||
        (stream.after !== null && typeof stream.after !== "string") ||
        !Number.isInteger(stream.offset) ||
        stream.offset < 0 ||
        stream.offset > PULL_REQUEST_PAGE_SIZE ||
        !Number.isInteger(stream.consumed) ||
        stream.consumed < 0 ||
        typeof stream.exhausted !== "boolean" ||
        typeof stream.limitReached !== "boolean"
      ) {
        throw new Error("invalid");
      }
    }
    return parsed as PullRequestCursor;
  } catch {
    throw new Error("GitHub pull request pagination cursor is invalid");
  }
}

function encodePullRequestCursor(cursor: PullRequestCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function comparePullRequests(
  left: RawPullRequest,
  right: RawPullRequest,
): number {
  const updatedDifference =
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updatedDifference !== 0) return updatedDifference;
  const repositoryDifference = left.repository.nameWithOwner.localeCompare(
    right.repository.nameWithOwner,
  );
  if (repositoryDifference !== 0) return repositoryDifference;
  return right.number - left.number || right.id.localeCompare(left.id);
}

function compareWorkflowRuns(
  left: { run: RawActionsWorkflowRun; target: ActionsRepositoryTarget },
  right: { run: RawActionsWorkflowRun; target: ActionsRepositoryTarget },
): number {
  const createdDifference =
    Date.parse(right.run.created_at) - Date.parse(left.run.created_at);
  if (createdDifference !== 0) return createdDifference;
  const repositoryDifference = left.target.nameWithOwner.localeCompare(
    right.target.nameWithOwner,
  );
  if (repositoryDifference !== 0) return repositoryDifference;
  return String(right.run.id).localeCompare(String(left.run.id));
}

function pipelineStatus(
  value: string | null | undefined,
): GitHubPipelineStatus {
  if (
    value === "ERROR" ||
    value === "EXPECTED" ||
    value === "FAILURE" ||
    value === "PENDING" ||
    value === "SUCCESS"
  ) {
    return value;
  }
  return "NONE";
}

function pullRequestSearchState(state: GitHubPullRequestStateFilter): string {
  if (state === "ALL") return "";
  if (state === "MERGED") return "is:merged";
  if (state === "CLOSED") return "is:closed is:unmerged";
  return "is:open";
}

function pullRequestSearchQuery(...parts: Array<string | null>): string {
  return parts.filter((part) => part?.trim()).join(" ");
}

function pipelineState(
  status: string | null | undefined,
  conclusion?: string | null,
): GitHubPipelineState {
  return normalizePipelineState(status, conclusion);
}

function retryUnavailableReason(
  checkSuite: RawCheckSuite,
  appConfigured: boolean,
): GitHubPipelineView["retryUnavailableReason"] {
  if (checkSuite.app?.slug !== "github-actions") return "NOT_GITHUB_ACTIONS";
  if (!checkSuite.workflowRun?.databaseId) return "WORKFLOW_RUN_UNAVAILABLE";
  if (checkSuite.status !== "COMPLETED") return "NOT_COMPLETED";
  if (!appConfigured) return "GITHUB_APP_NOT_CONFIGURED";
  return null;
}

function checkSuitePipeline(
  checkSuite: RawCheckSuite,
  appConfigured: boolean,
): GitHubPipelineView {
  const workflowRun = checkSuite.workflowRun;
  const unavailableReason = retryUnavailableReason(checkSuite, appConfigured);
  return {
    id: checkSuite.id,
    name:
      workflowRun?.workflow.name ??
      checkSuite.app?.name ??
      `Check suite ${checkSuite.id}`,
    status: pipelineState(checkSuite.status, checkSuite.conclusion),
    url: workflowRun?.url ?? checkSuite.url ?? null,
    checkSuiteId: checkSuite.id,
    canRetry: unavailableReason === null,
    retryUnavailableReason: unavailableReason,
    jobs: [],
    workflowRunId: workflowRun?.databaseId
      ? String(workflowRun.databaseId)
      : null,
    workflowId: null,
    runNumber: workflowRun?.runNumber ?? null,
    runAttempt: workflowRun?.runAttempt ?? null,
  };
}

function pipelineObservationFromContext(
  context: RawPipelineContext,
  appConfigured: boolean,
  sourceFetchedAt: Date,
): GitHubPipelineObservation {
  if (context.__typename === "CheckRun") {
    const pipeline = checkSuitePipeline(context.checkSuite, appConfigured);
    const updatedAt =
      context.checkSuite.workflowRun?.updatedAt ??
      context.completedAt ??
      context.startedAt;
    return {
      ...pipeline,
      jobs: undefined,
      source: "GRAPHQL",
      githubUpdatedAt: updatedAt ? new Date(updatedAt) : null,
      sourceFetchedAt,
    };
  }
  return {
    id: context.id,
    name: context.context,
    status: pipelineState(context.state),
    url: context.targetUrl,
    checkSuiteId: null,
    canRetry: false,
    retryUnavailableReason: "NOT_GITHUB_ACTIONS",
    jobs: [],
    workflowRunId: null,
    workflowId: null,
    runNumber: null,
    runAttempt: null,
    statusContext: context.context,
    source: "GRAPHQL",
    githubUpdatedAt: new Date(context.updatedAt),
    sourceFetchedAt,
  };
}

function graphqlPipelineFetchedAt(
  pullRequest: RawPullRequestLiveStatus,
  contexts: RawPipelineContext[],
): Date {
  const timestamps = [
    pullRequest.updatedAt,
    ...contexts.map((context) =>
      context.__typename === "StatusContext"
        ? context.updatedAt
        : (context.checkSuite.workflowRun?.updatedAt ??
          context.completedAt ??
          context.startedAt),
    ),
  ]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter(Number.isFinite);
  return new Date(timestamps.length > 0 ? Math.max(...timestamps) : 0);
}

function reviewDecision(value: string | null): GitHubReviewDecision {
  if (
    value === "APPROVED" ||
    value === "CHANGES_REQUESTED" ||
    value === "REVIEW_REQUIRED"
  ) {
    return value;
  }
  return "NONE";
}

function reviewThreadPullRequest(
  pullRequest: RawReviewThreadPullRequest,
  highlights?: Map<string, WorktreeHighlight>,
): GitHubReviewThreadPullRequest {
  const highlight = pullRequestWorktreeHighlight(pullRequest, highlights);
  return {
    id: pullRequest.id,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    repositoryNameWithOwner: pullRequest.repository.nameWithOwner,
    worktreeId: highlight?.id ?? null,
    worktreeHighlightColor: highlight?.highlightColor ?? null,
  };
}

function normalizeReviewComment(
  comment: RawReviewComment,
): GitHubReviewComment {
  return {
    id: comment.id,
    body: comment.body,
    bodyText: comment.bodyText,
    bodyHtml: comment.bodyHTML,
    url: comment.url,
    author: comment.author,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function normalizeReviewThread(
  thread: RawReviewThread,
  highlights?: Map<string, WorktreeHighlight>,
): GitHubReviewThread | null {
  const comments = connectionNodes(thread.comments);
  const root = comments.find((comment) => !comment.replyTo) ?? comments[0];
  if (!root) return null;
  return {
    id: thread.id,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    subjectType: thread.subjectType,
    path: thread.path,
    line: thread.line,
    startLine: thread.startLine,
    originalLine: thread.originalLine,
    originalStartLine: thread.originalStartLine,
    viewerCanReply: thread.viewerCanReply,
    viewerCanResolve: thread.viewerCanResolve,
    viewerCanUnresolve: thread.viewerCanUnresolve,
    resolvedBy: thread.resolvedBy,
    pullRequest: reviewThreadPullRequest(thread.pullRequest, highlights),
    rootComment: normalizeReviewComment(root),
    replies: comments
      .filter((comment) => comment.id !== root.id)
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      )
      .map(normalizeReviewComment),
  };
}

function normalizeReviewThreadState(thread: {
  id: string;
  isResolved: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  resolvedBy: RawActor | null;
}): GitHubReviewThreadState {
  return {
    id: thread.id,
    isResolved: thread.isResolved,
    viewerCanResolve: thread.viewerCanResolve,
    viewerCanUnresolve: thread.viewerCanUnresolve,
    resolvedBy: thread.resolvedBy,
  };
}

export class GitHubService {
  private autoRetryService: GitHubAutoRetryService | null = null;
  private readonly cache = new GitHubCache();
  private readonly graphqlFetchedAt = new WeakMap<object, Date>();

  constructor(
    startAutoRetry = false,
    private readonly credentials = new CredentialService(),
    private readonly polling?: PollingService,
    private readonly notificationsConfigurationChanged?: () => void,
    readonly pipelineStatus = new GitHubPipelineStatusService(),
  ) {
    if (startAutoRetry)
      this.autoRetryService = new GitHubAutoRetryService(this, this.polling);
  }

  private autoRetry(): GitHubAutoRetryService {
    return (this.autoRetryService ??= new GitHubAutoRetryService(
      this,
      this.polling,
    ));
  }

  private rememberGraphqlFetchedAt(value: unknown, fetchedAt: Date): void {
    const pending: unknown[] = [value];
    const visited = new WeakSet<object>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || typeof current !== "object" || visited.has(current)) {
        continue;
      }
      visited.add(current);
      this.graphqlFetchedAt.set(current, fetchedAt);
      pending.push(...Object.values(current));
    }
  }

  private pollingConfigurationChanged(): void {
    this.notificationsConfigurationChanged?.();
    this.autoRetryService?.configurationChanged();
  }

  autoRetryRules(input: {
    codebaseRepositoryId?: string | null;
    workflowRunId?: string | null;
  }): Promise<GitHubAutoRetryRuleView[]> {
    return this.autoRetry().list(input);
  }

  saveAutoRetryRule(
    input: SaveGitHubAutoRetryRuleInput,
  ): Promise<GitHubAutoRetryRuleView> {
    return this.autoRetry().save(input);
  }

  setAutoRetryRuleEnabled(
    id: string,
    enabled: boolean,
  ): Promise<GitHubAutoRetryRuleView> {
    return this.autoRetry().setEnabled(id, enabled);
  }

  deleteAutoRetryRule(id: string): Promise<boolean> {
    return this.autoRetry().delete(id);
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
    token: string,
    options: {
      requestSource: GitHubRequestSource;
      force?: boolean;
      allowStaleOnError?: boolean;
    },
  ): Promise<T> {
    const prepared = prepareGitHubGraphql(query);
    const requestInput = {
      authentication: "PAT" as const,
      requestSource: options.requestSource,
      endpoint: GITHUB_GRAPHQL_URL,
      operation: prepared.operation,
      query,
      normalizedQuery: prepared.normalizedQuery,
      variables,
      fetcher: () =>
        this.livePatGraphql<T>(prepared.liveQuery, variables, token),
    };
    if (prepared.kind === "mutation") {
      return this.cache.mutation(requestInput);
    }
    const result = await this.cache.query({ ...requestInput, ...options });
    this.rememberGraphqlFetchedAt(result.data, result.fetchedAt);
    return result.data;
  }

  private async livePatGraphql<T>(
    query: string,
    variables: Record<string, unknown>,
    token: string,
  ): Promise<{
    data: T;
    statusCode: number;
    pointCost: number | null;
    rateLimit: GitHubRateLimitMetadata | null;
  }> {
    let response: Response;
    try {
      response = await fetch(GITHUB_GRAPHQL_URL, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "ai-development-environment",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
      });
    } catch (error) {
      throw new GitHubRequestError(
        sanitizeError(
          error instanceof Error ? error.message : String(error),
          token,
        ),
        null,
        null,
      );
    }

    const rateLimit = await observeGitHubRateLimit("PAT", response);

    let body: GitHubResponse<T>;
    try {
      body = (await response.json()) as GitHubResponse<T>;
    } catch {
      throw new GitHubRequestError(
        `GitHub returned HTTP ${response.status}`,
        response.status,
        rateLimit,
      );
    }

    if (!response.ok || body.errors?.length || !body.data) {
      const message =
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ") || `GitHub returned HTTP ${response.status}`;
      throw new GitHubRequestError(
        sanitizeError(message, token),
        response.status,
        rateLimit,
      );
    }
    const extracted = extractGitHubGraphqlCost(body.data);
    return {
      data: extracted.data,
      statusCode: response.status,
      pointCost: extracted.pointCost,
      rateLimit,
    };
  }

  private async restRequest<T>(
    url: string,
    operation: GitHubRestOperation,
    token: string,
    requestSource: GitHubRequestSource,
  ): Promise<T> {
    const startedAt = Date.now();
    const record = (input: {
      statusCode?: number | null;
      error?: string | null;
      rateLimit?: GitHubRateLimitMetadata | null;
    }) =>
      this.cache
        .recordRestCall({
          authentication: "PAT",
          method: "GET",
          endpoint: url,
          operation,
          requestSource,
          durationMs: Date.now() - startedAt,
          ...input,
        })
        .catch(() => undefined);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "ai-development-environment",
          "x-github-api-version": "2022-11-28",
        },
        cache: "no-store",
      });
    } catch (error) {
      const message = sanitizeError(
        error instanceof Error ? error.message : String(error),
        token,
      );
      await record({ error: message });
      throw new Error(message);
    }
    const rateLimit = await observeGitHubRateLimit("PAT", response);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      const message = `GitHub returned HTTP ${response.status}`;
      await record({ statusCode: response.status, error: message, rateLimit });
      throw new Error(message);
    }
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : `GitHub returned HTTP ${response.status}`;
      const sanitized = sanitizeError(message, token);
      await record({
        statusCode: response.status,
        error: sanitized,
        rateLimit,
      });
      throw new Error(sanitized);
    }
    await record({ statusCode: response.status, rateLimit });
    return body as T;
  }

  private async restMutation(
    url: string,
    operation: GitHubRestOperation,
    token: string,
    requestSource: GitHubRequestSource,
    body: Record<string, unknown>,
  ): Promise<void> {
    const startedAt = Date.now();
    const record = (input: {
      statusCode?: number | null;
      error?: string | null;
      rateLimit?: GitHubRateLimitMetadata | null;
    }) =>
      this.cache
        .recordRestCall({
          authentication: "PAT",
          method: "POST",
          endpoint: url,
          operation,
          requestSource,
          durationMs: Date.now() - startedAt,
          ...input,
        })
        .catch(() => undefined);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "ai-development-environment",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });
    } catch (error) {
      const message = sanitizeError(
        error instanceof Error ? error.message : String(error),
        token,
      );
      await record({ error: message });
      throw new Error(message);
    }
    const rateLimit = await observeGitHubRateLimit("PAT", response);
    if (!response.ok) {
      let message = `GitHub returned HTTP ${response.status}`;
      try {
        const responseBody = (await response.json()) as { message?: unknown };
        if (typeof responseBody.message === "string") {
          message = responseBody.message;
        }
      } catch {
        // Preserve the status-only error when GitHub does not return JSON.
      }
      const sanitized = sanitizeError(message, token);
      await record({
        statusCode: response.status,
        error: sanitized,
        rateLimit,
      });
      throw new Error(sanitized);
    }
    await record({ statusCode: response.status, rateLimit });
  }

  private async appRequest<T>(
    credentials: GitHubAppCredentials,
    query: string,
    variables: Record<string, unknown>,
    options: {
      requestSource: GitHubRequestSource;
      force?: boolean;
      allowStaleOnError?: boolean;
    },
  ): Promise<{ data: T; githubRequestId: string | null }> {
    const prepared = prepareGitHubGraphql(query);
    let githubRequestId: string | null = null;
    const requestInput = {
      authentication: "APP" as const,
      requestSource: options.requestSource,
      endpoint: credentials.graphqlUrl,
      operation: prepared.operation,
      query,
      normalizedQuery: prepared.normalizedQuery,
      variables,
      fetcher: async () => {
        const result = await githubAppGraphql<T>(
          credentials,
          prepared.liveQuery,
          variables,
          options.requestSource,
        );
        githubRequestId = result.githubRequestId;
        const extracted = extractGitHubGraphqlCost(result.data);
        return {
          data: extracted.data,
          statusCode: result.statusCode ?? null,
          pointCost: extracted.pointCost,
          rateLimit: result.rateLimit ?? null,
        };
      },
    };
    let data: T;
    if (prepared.kind === "mutation") {
      data = await this.cache.mutation(requestInput);
    } else {
      const result = await this.cache.query({ ...requestInput, ...options });
      data = result.data;
      this.rememberGraphqlFetchedAt(data, result.fetchedAt);
    }
    return { data, githubRequestId };
  }

  private async workflowJobs(
    owner: string,
    repository: string,
    workflowRunId: string,
    token: string,
    appCredentials: GitHubAppCredentials | null,
    requestSource: GitHubRequestSource,
  ): Promise<GitHubWorkflowJobView[]> {
    const jobs: GitHubActionsWorkflowJob[] = appCredentials
      ? await listGitHubActionsWorkflowJobs(appCredentials, {
          owner,
          repository,
          workflowRunId,
          requestSource,
        })
      : await this.patWorkflowJobs(
          owner,
          repository,
          workflowRunId,
          token,
          "latest",
          requestSource,
        );
    return this.workflowJobViews(jobs, appCredentials !== null);
  }

  private workflowJobViews(
    jobs: GitHubActionsWorkflowJob[],
    appConfigured: boolean,
  ): GitHubWorkflowJobView[] {
    return jobs.map((job) => {
      const completed = job.status.toLowerCase() === "completed";
      return {
        id: String(job.id),
        name: job.name,
        status: pipelineState(job.status, job.conclusion),
        url: job.html_url,
        canRetry: completed && appConfigured,
        retryUnavailableReason: !completed
          ? "NOT_COMPLETED"
          : appConfigured
            ? null
            : "GITHUB_APP_NOT_CONFIGURED",
        steps: (job.steps ?? []).map((step) => ({
          number: step.number,
          name: step.name,
          status: pipelineState(step.status, step.conclusion),
        })),
        runAttempt: job.run_attempt ?? null,
      };
    });
  }

  private async patWorkflowJobs(
    owner: string,
    repository: string,
    workflowRunId: string,
    token: string,
    filter: "latest" | "all" = "latest",
    requestSource: GitHubRequestSource = "ACTIONS_PAGE",
  ): Promise<GitHubActionsWorkflowJob[]> {
    const jobs: GitHubActionsWorkflowJob[] = [];
    let page = 1;
    let totalCount = 0;
    do {
      const result = await this.restRequest<{
        total_count: number;
        jobs: GitHubActionsWorkflowJob[];
      }>(
        `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repository,
        )}/actions/runs/${encodeURIComponent(workflowRunId)}/jobs?filter=${filter}&per_page=100&page=${page}`,
        GITHUB_REST_OPERATIONS.actions.listJobsForWorkflowRun,
        token,
        requestSource,
      );
      totalCount = result.total_count;
      jobs.push(...result.jobs);
      page += 1;
    } while (jobs.length < totalCount);
    return jobs;
  }

  private async actionsPullRequestNumbers(
    run: RawActionsWorkflowRun,
    target: ActionsRepositoryTarget,
    token: string,
    requestSource: GitHubRequestSource,
  ): Promise<number[]> {
    const reported = [
      ...new Set(
        (run.pull_requests ?? [])
          .map((pullRequest) => pullRequest.number)
          .filter((number) => Number.isInteger(number) && number > 0),
      ),
    ];
    if (reported.length > 0 || !run.head_sha) return reported;
    try {
      const associated = await this.restRequest<Array<{ number: number }>>(
        `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(
          target.owner,
        )}/${encodeURIComponent(target.name)}/commits/${encodeURIComponent(
          run.head_sha,
        )}/pulls?per_page=100`,
        GITHUB_REST_OPERATIONS.repos.listPullRequestsAssociatedWithCommit,
        token,
        requestSource,
      );
      return [
        ...new Set(
          associated
            .map((pullRequest) => pullRequest.number)
            .filter((number) => Number.isInteger(number) && number > 0),
        ),
      ];
    } catch {
      // Pull request association is supplementary; keep the workflow run visible.
      return [];
    }
  }

  private async requireToken(): Promise<string> {
    const token = await this.credentials.getText(
      CREDENTIALS.githubPersonalAccessToken,
    );
    if (!token) {
      throw new Error("GitHub credentials are not configured");
    }
    return token;
  }

  async getSettings(): Promise<GitHubSettingsView> {
    const prisma = await getPrismaClient();
    const settings = await prisma.gitHubSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
    return {
      tokenConfigured: await this.credentials.isConfigured(
        CREDENTIALS.githubPersonalAccessToken,
      ),
      defaultJiraKeyRegex: settings.defaultJiraKeyRegex,
      actionsNotificationPollIntervalSeconds:
        settings.actionsNotificationPollIntervalSeconds,
      cacheTtlSeconds: settings.cacheTtlSeconds,
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  async saveSettings(input: {
    apiToken?: string | null;
    defaultJiraKeyRegex?: string | null;
    actionsNotificationPollIntervalSeconds?: number | null;
  }): Promise<GitHubSettingsView> {
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    const nextToken = input.apiToken?.trim() || null;
    const tokenConfigured = await this.credentials.isConfigured(
      CREDENTIALS.githubPersonalAccessToken,
    );
    if (input.apiToken !== undefined && !nextToken && !tokenConfigured)
      throw new Error("A GitHub personal access token is required");
    const defaultJiraKeyRegex =
      input.defaultJiraKeyRegex === undefined
        ? (existing?.defaultJiraKeyRegex ?? DEFAULT_JIRA_KEY_REGEX)
        : normalizeJiraKeyRegex(input.defaultJiraKeyRegex);
    if (!defaultJiraKeyRegex) {
      throw new Error("A default Jira key regex is required");
    }
    const actionsNotificationPollIntervalSeconds =
      input.actionsNotificationPollIntervalSeconds ??
      existing?.actionsNotificationPollIntervalSeconds ??
      60;
    if (
      !Number.isInteger(actionsNotificationPollIntervalSeconds) ||
      actionsNotificationPollIntervalSeconds <
        MIN_ACTIONS_NOTIFICATION_POLL_INTERVAL_SECONDS ||
      actionsNotificationPollIntervalSeconds >
        MAX_ACTIONS_NOTIFICATION_POLL_INTERVAL_SECONDS
    ) {
      throw new Error(
        `Actions notification poll interval must be an integer from ${MIN_ACTIONS_NOTIFICATION_POLL_INTERVAL_SECONDS} to ${MAX_ACTIONS_NOTIFICATION_POLL_INTERVAL_SECONDS} seconds`,
      );
    }
    const settingsData = {
      defaultJiraKeyRegex,
      actionsNotificationPollIntervalSeconds,
    };
    if (nextToken) {
      await this.credentials.setText(
        CREDENTIALS.githubPersonalAccessToken,
        nextToken,
        async (transaction) => {
          await transaction.gitHubSettings.upsert({
            where: { id: SETTINGS_ID },
            create: { id: SETTINGS_ID, ...settingsData },
            update: settingsData,
          });
        },
      );
      await this.cache.clearForCredentialChange("PAT");
    } else {
      await prisma.gitHubSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID, ...settingsData },
        update: settingsData,
      });
    }
    this.pollingConfigurationChanged();
    return this.getSettings();
  }

  async clearCredentials(): Promise<GitHubSettingsView> {
    await this.credentials.delete(
      CREDENTIALS.githubPersonalAccessToken,
      async (transaction) => {
        await transaction.gitHubSettings.upsert({
          where: { id: SETTINGS_ID },
          create: { id: SETTINGS_ID },
          update: {},
        });
      },
    );
    await this.cache.clearForCredentialChange("PAT");
    this.pollingConfigurationChanged();
    return this.getSettings();
  }

  async rateLimitSnapshots(): Promise<GitHubRateLimitSnapshotView[]> {
    return listGitHubRateLimitSnapshots();
  }

  async cacheMetrics(): Promise<GitHubCacheMetrics> {
    return this.cache.metrics();
  }

  async apiCalls(
    limit = 50,
    offset = 0,
    filters: GitHubApiCallFilters = {},
  ): Promise<GitHubPaginatedResult<GitHubApiCallView>> {
    return this.cache.calls(limit, offset, filters);
  }

  async cachedEntries(
    limit = 50,
    offset = 0,
  ): Promise<GitHubPaginatedResult<GitHubCachedEntryView>> {
    return this.cache.entries(limit, offset);
  }

  async cachedEntry(id: string): Promise<GitHubCachedEntryDetail | null> {
    return this.cache.entry(id);
  }

  async cacheTtlOverrides(): Promise<GitHubCacheTtlOverrideView[]> {
    return this.cache.ttlOverrides();
  }

  async cacheableGraphqlOperations(): Promise<string[]> {
    return this.cache.cacheableOperations();
  }

  async effectiveCacheTtlSeconds(operation: string): Promise<number> {
    return this.cache.effectiveTtlSeconds(operation);
  }

  async saveCacheTtlOverride(
    operation: string,
    ttlSeconds: number,
  ): Promise<GitHubCacheTtlOverrideView> {
    return this.cache.saveTtlOverride(operation, ttlSeconds);
  }

  async deleteCacheTtlOverride(operation: string): Promise<boolean> {
    return this.cache.deleteTtlOverride(operation);
  }

  async updateCacheTtl(ttlMinutes: number): Promise<GitHubSettingsView> {
    return this.cache.updateTtl(ttlMinutes, () => this.getSettings());
  }

  async clearCache(): Promise<boolean> {
    return this.cache.clear();
  }

  async clearApiCalls(): Promise<boolean> {
    return this.cache.clearCalls();
  }

  async deleteCachedEntry(id: string): Promise<boolean> {
    return this.cache.delete(id);
  }

  async refreshCachedEntry(id: string): Promise<GitHubCachedEntryDetail> {
    const entry = await this.cache.entry(id);
    if (!entry) throw new Error("GitHub cached entry not found");
    const variables =
      entry.variables && typeof entry.variables === "object"
        ? (entry.variables as Record<string, unknown>)
        : {};
    if (entry.authentication === "PAT") {
      await this.request(entry.query, variables, await this.requireToken(), {
        requestSource: "CACHE_MANAGEMENT",
        force: true,
        allowStaleOnError: false,
      });
    } else {
      await this.appRequest(
        await this.requireAppCredentials(),
        entry.query,
        variables,
        {
          requestSource: "CACHE_MANAGEMENT",
          force: true,
          allowStaleOnError: false,
        },
      );
    }
    const refreshed = await this.cache.entry(id);
    if (!refreshed) throw new Error("GitHub cached entry not found");
    return refreshed;
  }

  private async audit(
    context: GitHubAuditContext,
    input: {
      operation: string;
      repositoryId?: string | null;
      checkSuiteId?: string | null;
      jobId?: string | null;
      githubRequestId?: string | null;
      outcome: "SUCCESS" | "FAILURE";
      errorCode?: string | null;
    },
  ): Promise<void> {
    try {
      const prisma = await getPrismaClient();
      await prisma.gitHubAuditEvent.create({
        data: {
          id: randomUUID(),
          scopeId: GITHUB_APP_SETTINGS_ID,
          actor: context.actor,
          ipAddress: context.ipAddress,
          operation: input.operation,
          repositoryId: input.repositoryId ?? null,
          checkSuiteId: input.checkSuiteId ?? null,
          jobId: input.jobId ?? null,
          githubRequestId: input.githubRequestId ?? null,
          outcome: input.outcome,
          errorCode: input.errorCode ?? null,
          autoRetryRuleId: context.autoRetryRuleId ?? null,
          autoRetryExecutionId: context.autoRetryExecutionId ?? null,
        },
      });
    } catch {
      console.error("Failed to write a GitHub audit event");
    }
  }

  private appSettingsView(
    settings: {
      appId: string;
      installationId: string;
      keyFingerprint: string;
      appSlug: string;
      appOwnerLogin: string | null;
      appOwnerType: string | null;
      accountLogin: string;
      repositorySelection: string;
      actionsPermission: string;
      checksPermission: string | null;
      commitStatusesPermission: string | null;
      webhookEventsJson: string;
      enhancedPipelineWebhooksEnabled: boolean;
      verifiedAt: Date;
      webhookUrl: string | null;
      webhookConfiguredAt: Date | null;
      updatedAt: Date;
    } | null,
    privateKeyConfigured: boolean,
    webhookSecretConfigured: boolean,
    lastDelivery: {
      receivedAt: Date;
      outcome: string;
      error: string | null;
    } | null,
  ): GitHubAppSettingsView {
    const webhookEvents = settings
      ? jsonStringArray(settings.webhookEventsJson)
      : [];
    const webhookConfigured = Boolean(
      settings?.webhookUrl &&
      settings.webhookConfiguredAt &&
      webhookSecretConfigured,
    );
    const enhancedPipelineWebhooksMissing = settings
      ? enhancedPipelineWebhookRequirements({
          webhookConfigured,
          actionsPermission: settings.actionsPermission,
          checksPermission: settings.checksPermission,
          commitStatusesPermission: settings.commitStatusesPermission,
          webhookEvents,
        })
      : ["Configure and verify the GitHub App"];
    return {
      configured: Boolean(settings && privateKeyConfigured),
      appId: settings?.appId ?? null,
      installationId: settings?.installationId ?? null,
      privateKeyConfigured,
      keyFingerprint: settings?.keyFingerprint ?? null,
      appSlug: settings?.appSlug ?? null,
      appOwnerLogin: settings?.appOwnerLogin ?? null,
      appOwnerType: settings?.appOwnerType ?? null,
      accountLogin: settings?.accountLogin ?? null,
      repositorySelection: settings?.repositorySelection ?? null,
      actionsPermission: settings?.actionsPermission ?? null,
      checksPermission: settings?.checksPermission ?? null,
      commitStatusesPermission: settings?.commitStatusesPermission ?? null,
      webhookEvents,
      enhancedPipelineWebhooksEnabled:
        settings?.enhancedPipelineWebhooksEnabled ?? false,
      enhancedPipelineWebhooksReady:
        enhancedPipelineWebhooksMissing.length === 0,
      enhancedPipelineWebhooksMissing,
      verifiedAt: settings?.verifiedAt.toISOString() ?? null,
      webhookConfigured,
      webhookUrl: settings?.webhookUrl ?? null,
      webhookConfiguredAt: settings?.webhookConfiguredAt?.toISOString() ?? null,
      webhookLastReceivedAt: lastDelivery?.receivedAt.toISOString() ?? null,
      webhookLastOutcome: lastDelivery?.outcome ?? null,
      webhookLastError: lastDelivery?.error ?? null,
      updatedAt: settings?.updatedAt.toISOString() ?? null,
    };
  }

  async getAppSettings(): Promise<GitHubAppSettingsView> {
    const prisma = await getPrismaClient();
    const [
      storedSettings,
      privateKeyConfigured,
      webhookSecretConfigured,
      lastDelivery,
    ] = await Promise.all([
      prisma.gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
      }),
      this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey),
      this.credentials.isConfigured(CREDENTIALS.githubAppWebhookSecret),
      prisma.gitHubWebhookDelivery.findFirst({
        orderBy: { receivedAt: "desc" },
        select: { receivedAt: true, outcome: true, error: true },
      }),
    ]);
    let settings = storedSettings;
    if (
      settings &&
      privateKeyConfigured &&
      (!settings.appOwnerLogin || !settings.appOwnerType)
    ) {
      try {
        const registration = await getGitHubAppRegistration(
          await this.appCredentials(settings),
        );
        settings = await prisma.gitHubAppSettings.update({
          where: { id: GITHUB_APP_SETTINGS_ID },
          data: {
            appSlug: registration.appSlug,
            appOwnerLogin: registration.appOwnerLogin,
            appOwnerType: registration.appOwnerType,
          },
        });
      } catch {
        // Owner metadata is supplemental; keep settings available if GitHub
        // cannot be reached during the one-time backfill.
      }
    }
    return this.appSettingsView(
      settings,
      privateKeyConfigured,
      webhookSecretConfigured,
      lastDelivery,
    );
  }

  async webhooksEnabled(): Promise<boolean> {
    const [settings, secretConfigured] = await Promise.all([
      (await getPrismaClient()).gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
        select: { webhookUrl: true, webhookConfiguredAt: true },
      }),
      this.credentials.isConfigured(CREDENTIALS.githubAppWebhookSecret),
    ]);
    return Boolean(
      settings?.webhookUrl && settings.webhookConfiguredAt && secretConfigured,
    );
  }

  async webhookDeliveries(
    limit = 50,
    offset = 0,
  ): Promise<GitHubWebhookDeliveryPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer from 1 to 100");
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("offset must be a non-negative integer");
    }
    const enabled = await this.webhooksEnabled();
    if (!enabled) {
      return { enabled, items: [], total: 0, limit, offset };
    }
    const prisma = await getPrismaClient();
    const [deliveries, total] = await Promise.all([
      prisma.gitHubWebhookDelivery.findMany({
        take: limit,
        skip: offset,
        orderBy: [{ receivedAt: "desc" }, { deliveryId: "desc" }],
      }),
      prisma.gitHubWebhookDelivery.count(),
    ]);
    return {
      enabled,
      total,
      limit,
      offset,
      items: deliveries.map((delivery) => ({
        deliveryId: delivery.deliveryId,
        event: delivery.event,
        action: delivery.action,
        repositoryName: delivery.repositoryName,
        workflowRunId: delivery.workflowRunId,
        outcome: delivery.outcome,
        error: delivery.error,
        receivedAt: delivery.receivedAt.toISOString(),
        processedAt: delivery.processedAt?.toISOString() ?? null,
      })),
    };
  }

  async clearWebhookDeliveries(): Promise<boolean> {
    const prisma = await getPrismaClient();
    await prisma.gitHubWebhookDelivery.deleteMany();
    return true;
  }

  private async requireAppCredentials(): Promise<GitHubAppCredentials> {
    const prisma = await getPrismaClient();
    const settings = await prisma.gitHubAppSettings.findUnique({
      where: { id: GITHUB_APP_SETTINGS_ID },
    });
    if (!settings) {
      throw new GitHubAppError(
        "GITHUB_APP_NOT_CONFIGURED",
        "A verified GitHub App is required to manage GitHub Actions workflows",
      );
    }
    return this.appCredentials(settings);
  }

  private async appCredentials(settings: {
    appId: string;
    installationId: string;
    apiBaseUrl: string;
    graphqlUrl: string;
    keyFingerprint: string;
  }): Promise<GitHubAppCredentials> {
    const privateKey = await this.credentials.getText(
      CREDENTIALS.githubAppPrivateKey,
    );
    if (!privateKey) {
      throw new GitHubAppError(
        "GITHUB_APP_NOT_CONFIGURED",
        "A verified GitHub App is required to manage GitHub Actions workflows",
      );
    }
    return {
      appId: settings.appId,
      installationId: settings.installationId,
      privateKey,
      apiBaseUrl: settings.apiBaseUrl,
      graphqlUrl: settings.graphqlUrl,
      keyFingerprint: settings.keyFingerprint,
      ...this.appTransportObservers(settings.graphqlUrl),
    };
  }

  private appTransportObservers(
    graphqlUrl: string,
    logGraphqlTransport = false,
  ) {
    return {
      responseObserver: (response: Response) =>
        observeGitHubRateLimit("APP", response).then(() => undefined),
      requestObserver: (observation: {
        url: string;
        method: string;
        operation: GitHubRestOperation | null;
        requestSource: GitHubRequestSource;
        body: string | null;
        durationMs: number;
        statusCode: number | null;
        error: string | null;
        rateLimit: GitHubRateLimitMetadata | null;
      }) => {
        if (observation.url === graphqlUrl) {
          if (!logGraphqlTransport) return;
          let operation = "GitHubAppGraphql";
          let variables: Record<string, unknown> = {};
          try {
            const body = JSON.parse(observation.body ?? "{}") as {
              query?: unknown;
              variables?: unknown;
            };
            if (typeof body.query === "string") {
              operation = prepareGitHubGraphql(body.query).operation;
            }
            if (
              body.variables &&
              typeof body.variables === "object" &&
              !Array.isArray(body.variables)
            ) {
              variables = body.variables as Record<string, unknown>;
            }
          } catch {
            // Keep a generic operation when an observer cannot parse a body.
          }
          return this.cache.recordGraphqlTransportCall({
            authentication: "APP",
            endpoint: observation.url,
            operation,
            requestSource: observation.requestSource,
            variables,
            durationMs: observation.durationMs,
            statusCode: observation.statusCode,
            error: observation.error,
            rateLimit: observation.rateLimit,
          });
        }
        if (!observation.operation) return;
        return this.cache.recordRestCall({
          authentication: "APP",
          method: observation.method,
          endpoint: observation.url,
          operation: observation.operation,
          requestSource: observation.requestSource,
          durationMs: observation.durationMs,
          statusCode: observation.statusCode,
          error: observation.error,
          rateLimit: observation.rateLimit,
        });
      },
    };
  }

  async saveAppSettings(
    input: {
      appId: string;
      installationId: string;
      privateKey?: string | null;
      webhookUrl?: string | null;
      enhancedPipelineWebhooksEnabled?: boolean | null;
    },
    auditContext: GitHubAuditContext,
    requestOrigin: string | null = null,
  ): Promise<GitHubAppSettingsView> {
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubAppSettings.findUnique({
      where: { id: GITHUB_APP_SETTINGS_ID },
    });
    const replacementPrivateKey = input.privateKey?.trim() || null;
    try {
      if (
        existing &&
        existing.appId !== input.appId.trim() &&
        !replacementPrivateKey
      ) {
        throw new GitHubAppError(
          "INVALID_PRIVATE_KEY",
          "A replacement private key is required when the GitHub App ID changes",
        );
      }
      const privateKey =
        replacementPrivateKey ??
        (await this.credentials.getText(CREDENTIALS.githubAppPrivateKey));
      if (!privateKey) {
        throw new GitHubAppError(
          "INVALID_PRIVATE_KEY",
          "A GitHub App private key is required",
        );
      }
      const webhookUrl = this.webhookUrl(
        input.webhookUrl !== undefined
          ? input.webhookUrl
          : (existing?.webhookUrl ?? undefined),
        requestOrigin,
      );
      clearGitHubAppTokenCache();
      const credentials: GitHubAppCredentials = {
        appId: input.appId,
        installationId: input.installationId,
        privateKey,
        apiBaseUrl: GITHUB_API_BASE_URL,
        graphqlUrl: GITHUB_GRAPHQL_URL,
        ...this.appTransportObservers(GITHUB_GRAPHQL_URL, true),
      };
      const verification = await verifyGitHubAppConfiguration(credentials);
      const enhancedPipelineWebhooksEnabled =
        input.enhancedPipelineWebhooksEnabled ??
        existing?.enhancedPipelineWebhooksEnabled ??
        false;
      if (enhancedPipelineWebhooksEnabled) {
        const permissionOrEventMissing = enhancedPipelineWebhookRequirements({
          webhookConfigured: true,
          actionsPermission: verification.actionsPermission,
          checksPermission: verification.checksPermission,
          commitStatusesPermission: verification.commitStatusesPermission,
          webhookEvents: verification.webhookEvents,
        });
        if (permissionOrEventMissing.length > 0) {
          throw new Error(
            `Enhanced pipeline webhooks are not ready: ${permissionOrEventMissing.join("; ")}`,
          );
        }
      }
      const existingWebhookSecret = await this.credentials.getText(
        CREDENTIALS.githubAppWebhookSecret,
      );
      const webhookSecret = webhookUrl
        ? (existingWebhookSecret ?? randomBytes(32).toString("base64url"))
        : existingWebhookSecret;
      let storedWebhookUrl = existing?.webhookUrl ?? null;
      let webhookConfiguredAt = existing?.webhookConfiguredAt ?? null;
      const webhookShouldBeConfigured =
        Boolean(webhookUrl) &&
        (input.webhookUrl !== undefined || !existing?.webhookUrl);
      if (webhookShouldBeConfigured || input.webhookUrl !== undefined) {
        storedWebhookUrl = webhookUrl;
        webhookConfiguredAt = null;
      }
      if (webhookShouldBeConfigured && webhookUrl && webhookSecret) {
        const configuration = await configureGitHubAppWebhook(credentials, {
          url: webhookUrl,
          secret: webhookSecret,
        });
        webhookConfiguredAt = configuration.configured ? new Date() : null;
      }
      if (enhancedPipelineWebhooksEnabled) {
        const missing = enhancedPipelineWebhookRequirements({
          webhookConfigured: Boolean(webhookConfiguredAt && webhookUrl),
          actionsPermission: verification.actionsPermission,
          checksPermission: verification.checksPermission,
          commitStatusesPermission: verification.commitStatusesPermission,
          webhookEvents: verification.webhookEvents,
        });
        if (missing.length > 0) {
          throw new Error(
            `Enhanced pipeline webhooks are not ready: ${missing.join("; ")}`,
          );
        }
      }
      const credentialEntries = [
        {
          descriptor: CREDENTIALS.githubAppPrivateKey,
          value: Buffer.from(privateKey, "utf8"),
        },
        ...(webhookSecret
          ? [
              {
                descriptor: CREDENTIALS.githubAppWebhookSecret,
                value: Buffer.from(webhookSecret, "utf8"),
              },
            ]
          : []),
      ];
      await this.credentials.setMany(credentialEntries, async (transaction) => {
        const data = {
          appId: verification.appId,
          installationId: verification.installationId,
          apiBaseUrl: GITHUB_API_BASE_URL,
          graphqlUrl: GITHUB_GRAPHQL_URL,
          keyFingerprint: verification.keyFingerprint,
          appSlug: verification.appSlug,
          appOwnerLogin: verification.appOwnerLogin,
          appOwnerType: verification.appOwnerType,
          accountLogin: verification.accountLogin,
          repositorySelection: verification.repositorySelection,
          actionsPermission: verification.actionsPermission,
          checksPermission: verification.checksPermission,
          commitStatusesPermission: verification.commitStatusesPermission,
          webhookEventsJson: JSON.stringify(verification.webhookEvents),
          enhancedPipelineWebhooksEnabled,
          verifiedAt: verification.verifiedAt,
          webhookUrl: storedWebhookUrl,
          webhookConfiguredAt,
        };
        await transaction.gitHubAppSettings.upsert({
          where: { id: GITHUB_APP_SETTINGS_ID },
          create: { id: GITHUB_APP_SETTINGS_ID, ...data },
          update: data,
        });
      });
      await this.audit(auditContext, {
        operation: "GITHUB_APP_SETTINGS_SAVE",
        outcome: "SUCCESS",
        githubRequestId: verification.githubRequestId,
      });
      await this.cache.clearForCredentialChange("APP");
      this.notificationsConfigurationChanged?.();
      return this.getAppSettings();
    } catch (error) {
      await this.audit(auditContext, {
        operation: "GITHUB_APP_SETTINGS_SAVE",
        outcome: "FAILURE",
        errorCode:
          error instanceof GitHubAppError
            ? error.code
            : "GITHUB_APP_REQUEST_FAILED",
        githubRequestId:
          error instanceof GitHubAppError ? error.githubRequestId : null,
      });
      throw error;
    }
  }

  private webhookUrl(
    configuredUrl: string | null | undefined,
    origin: string | null,
  ): string | null {
    const explicit = configuredUrl !== undefined;
    const candidate = explicit
      ? configuredUrl?.trim() || null
      : origin
        ? `${origin.replace(/\/$/, "")}/api/public/github/webhook`
        : null;
    if (!candidate) return null;
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      const isPrivateHost =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "::1" ||
        host === "0.0.0.0" ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(host) ||
        /^f[cd][0-9a-f]{2}:/.test(host) ||
        /^fe[89ab][0-9a-f]:/.test(host);
      const isPublicHttps =
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !isPrivateHost;
      if (!isPublicHttps) {
        if (explicit) {
          throw new Error(
            "Webhook URL must be a public HTTPS URL without credentials, a query, or a fragment",
          );
        }
        return null;
      }
      return url.toString();
    } catch {
      if (explicit) {
        throw new Error(
          "Webhook URL must be a public HTTPS URL without credentials, a query, or a fragment",
        );
      }
      return null;
    }
  }

  async testAppConnection(
    auditContext: GitHubAuditContext,
  ): Promise<GitHubAppSettingsView> {
    try {
      const credentials = await this.requireAppCredentials();
      clearGitHubAppTokenCache();
      const verification = await verifyGitHubAppConfiguration({
        ...credentials,
        ...this.appTransportObservers(credentials.graphqlUrl, true),
      });
      const prisma = await getPrismaClient();
      await prisma.gitHubAppSettings.update({
        where: { id: GITHUB_APP_SETTINGS_ID },
        data: {
          keyFingerprint: verification.keyFingerprint,
          appSlug: verification.appSlug,
          appOwnerLogin: verification.appOwnerLogin,
          appOwnerType: verification.appOwnerType,
          accountLogin: verification.accountLogin,
          repositorySelection: verification.repositorySelection,
          actionsPermission: verification.actionsPermission,
          checksPermission: verification.checksPermission,
          commitStatusesPermission: verification.commitStatusesPermission,
          webhookEventsJson: JSON.stringify(verification.webhookEvents),
          verifiedAt: verification.verifiedAt,
        },
      });
      await this.audit(auditContext, {
        operation: "GITHUB_APP_CONNECTION_TEST",
        outcome: "SUCCESS",
        githubRequestId: verification.githubRequestId,
      });
      return this.getAppSettings();
    } catch (error) {
      await this.audit(auditContext, {
        operation: "GITHUB_APP_CONNECTION_TEST",
        outcome: "FAILURE",
        errorCode:
          error instanceof GitHubAppError
            ? error.code
            : "GITHUB_APP_REQUEST_FAILED",
        githubRequestId:
          error instanceof GitHubAppError ? error.githubRequestId : null,
      });
      throw error;
    }
  }

  async clearAppCredentials(
    auditContext: GitHubAuditContext,
  ): Promise<GitHubAppSettingsView> {
    await this.credentials.deleteMany(
      [CREDENTIALS.githubAppPrivateKey, CREDENTIALS.githubAppWebhookSecret],
      async (transaction) => {
        await transaction.gitHubAppSettings.deleteMany({
          where: { id: GITHUB_APP_SETTINGS_ID },
        });
      },
    );
    clearGitHubAppTokenCache();
    await this.cache.clearForCredentialChange("APP");
    await this.audit(auditContext, {
      operation: "GITHUB_APP_SETTINGS_CLEAR",
      outcome: "SUCCESS",
    });
    this.notificationsConfigurationChanged?.();
    return this.getAppSettings();
  }

  private async viewer(token: string, force = false): Promise<GitHubViewer> {
    const data = await this.request<{ viewer: GitHubViewer }>(
      `query GitHubViewer { viewer { login name avatarUrl url } }`,
      {},
      token,
      {
        requestSource: "GITHUB_SETTINGS",
        force,
        allowStaleOnError: !force,
      },
    );
    return data.viewer;
  }

  async testConnection(): Promise<GitHubViewer> {
    return this.viewer(await this.requireToken(), true);
  }

  async listRepositories(): Promise<GitHubRepositoryView[]> {
    const prisma = await getPrismaClient();
    const repositories = await prisma.gitHubRepository.findMany({
      orderBy: { nameWithOwner: "asc" },
    });
    return repositories.map(repositoryView);
  }

  async availableRepositories(
    after?: string | null,
  ): Promise<GitHubRepositoryCandidatePage> {
    const token = await this.requireToken();
    const data = await this.request<{
      viewer: {
        repositories: RawConnection<{
          id: string;
          nameWithOwner: string;
          url: string;
          isPrivate: boolean;
        }>;
      };
    }>(
      `query GitHubAvailableRepositories($after: String) {
        viewer {
          repositories(
            first: 50
            after: $after
            affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
            ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
            isArchived: false
            orderBy: { field: PUSHED_AT, direction: DESC }
          ) {
            nodes { id nameWithOwner url isPrivate }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { after: after || null },
      token,
      { requestSource: "PULL_REQUESTS_PAGE" },
    );
    const prisma = await getPrismaClient();
    const managed = new Set(
      (
        await prisma.gitHubRepository.findMany({ select: { githubId: true } })
      ).map((repository) => repository.githubId),
    );
    const connection = data.viewer.repositories;
    return {
      items: connectionNodes(connection).map((repository) => ({
        githubId: repository.id,
        nameWithOwner: repository.nameWithOwner,
        url: repository.url,
        isPrivate: repository.isPrivate,
        managed: managed.has(repository.id),
      })),
      hasNextPage: connection.pageInfo.hasNextPage,
      endCursor: connection.pageInfo.endCursor,
    };
  }

  async actionsWorkflowRuns(
    codebaseRepositoryId?: string | null,
    first = ACTIONS_PAGE_SIZE,
    after?: string | null,
    branch?: string | null,
    workflowId?: string | null,
    requestSource: GitHubRequestSource = "ACTIONS_PAGE",
  ): Promise<GitHubActionsWorkflowRunPage> {
    if (!Number.isInteger(first) || first < 1 || first > ACTIONS_PAGE_SIZE) {
      throw new Error(
        `first must be an integer from 1 to ${ACTIONS_PAGE_SIZE}`,
      );
    }
    const selectedRepositoryId = codebaseRepositoryId?.trim() || null;
    const selectedBranch = branch?.trim() || null;
    const selectedWorkflowId = workflowId?.trim() || null;
    if ((selectedBranch || selectedWorkflowId) && !selectedRepositoryId) {
      throw new Error(
        "A repository is required to filter Actions by branch or pipeline",
      );
    }
    const cursor = decodeActionsCursor(
      after,
      selectedRepositoryId,
      selectedBranch,
      selectedWorkflowId,
    );
    const token = await this.requireToken();
    const prisma = await getPrismaClient();
    const codebaseRepositories = await prisma.codebaseRepository.findMany({
      orderBy: [{ name: "asc" }, { canonicalOrigin: "asc" }],
      select: {
        id: true,
        canonicalOrigin: true,
        jiraBranchRegex: true,
      },
    });
    const repositories = codebaseRepositories
      .map(actionsRepositoryTarget)
      .filter((item): item is ActionsRepositoryTarget => item !== null)
      .sort((left, right) =>
        left.nameWithOwner.localeCompare(right.nameWithOwner),
      );
    const targets = selectedRepositoryId
      ? repositories.filter((item) => item.id === selectedRepositoryId)
      : repositories;
    if (selectedRepositoryId && targets.length === 0) {
      throw new Error("GitHub codebase repository was not found");
    }

    type WorkflowRunStream = {
      target: ActionsRepositoryTarget;
      consumed: number;
      loadedPage: number | null;
      runs: RawActionsWorkflowRun[];
      totalCount: number;
      current: RawActionsWorkflowRun | null;
      failed: boolean;
    };
    const streams: WorkflowRunStream[] = targets.map((target) => ({
      target,
      consumed: cursor.consumed[target.id] ?? 0,
      loadedPage: null,
      runs: [],
      totalCount: Number.POSITIVE_INFINITY,
      current: null,
      failed: false,
    }));
    const repositoryErrors: GitHubActionsRepositoryErrorView[] = [];

    const ensureCurrent = async (stream: WorkflowRunStream) => {
      if (stream.failed || stream.consumed >= stream.totalCount) {
        stream.current = null;
        return;
      }
      const page = Math.floor(stream.consumed / ACTIONS_PAGE_SIZE) + 1;
      const offset = stream.consumed % ACTIONS_PAGE_SIZE;
      try {
        if (stream.loadedPage !== page) {
          const workflowPath = selectedWorkflowId
            ? `/actions/workflows/${encodeURIComponent(selectedWorkflowId)}/runs`
            : "/actions/runs";
          const operation = selectedWorkflowId
            ? GITHUB_REST_OPERATIONS.actions.listWorkflowRuns
            : GITHUB_REST_OPERATIONS.actions.listWorkflowRunsForRepo;
          const result = await this.restRequest<{
            total_count: number;
            workflow_runs: RawActionsWorkflowRun[];
          }>(
            `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(
              stream.target.owner,
            )}/${encodeURIComponent(
              stream.target.name,
            )}${workflowPath}?per_page=${ACTIONS_PAGE_SIZE}&page=${page}${
              selectedBranch
                ? `&branch=${encodeURIComponent(selectedBranch)}`
                : ""
            }`,
            operation,
            token,
            requestSource,
          );
          if (
            !Number.isInteger(result.total_count) ||
            !Array.isArray(result.workflow_runs)
          ) {
            throw new Error(
              "GitHub returned an invalid workflow runs response",
            );
          }
          stream.loadedPage = page;
          stream.runs = result.workflow_runs;
          stream.totalCount = result.total_count;
        }
        stream.current = stream.runs[offset] ?? null;
      } catch (error) {
        stream.failed = true;
        stream.current = null;
        repositoryErrors.push({
          codebaseRepositoryId: stream.target.id,
          nameWithOwner: stream.target.nameWithOwner,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    await Promise.all(streams.map(ensureCurrent));
    const selectedRuns: Array<{
      run: RawActionsWorkflowRun;
      target: ActionsRepositoryTarget;
    }> = [];
    while (selectedRuns.length < first) {
      const next = streams
        .filter(
          (
            stream,
          ): stream is WorkflowRunStream & {
            current: RawActionsWorkflowRun;
          } => stream.current !== null,
        )
        .map((stream) => ({
          stream,
          run: stream.current,
          target: stream.target,
        }))
        .sort(compareWorkflowRuns)[0];
      if (!next) break;
      selectedRuns.push({ run: next.run, target: next.target });
      next.stream.consumed += 1;
      await ensureCurrent(next.stream);
    }

    const [settings, codebaseSettings, appSettings, managedRepositories] =
      await Promise.all([
        prisma.gitHubSettings.findUnique({ where: { id: SETTINGS_ID } }),
        prisma.codebaseSettings.findUnique({ where: { id: "default" } }),
        prisma.gitHubAppSettings.findUnique({
          where: { id: GITHUB_APP_SETTINGS_ID },
        }),
        prisma.gitHubRepository.findMany(),
      ]);
    const targetIds = [...new Set(selectedRuns.map(({ target }) => target.id))];
    const worktrees = targetIds.length
      ? await prisma.worktree.findMany({
          where: {
            missingAt: null,
            codebase: { repositoryId: { in: targetIds } },
          },
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            branch: true,
            highlightColor: true,
            codebase: { select: { repositoryId: true } },
          },
        })
      : [];
    const worktreeByRepositoryAndBranch = new Map<string, WorktreeHighlight>();
    for (const worktree of worktrees) {
      if (!worktree.branch) continue;
      const key = `${worktree.codebase.repositoryId}\u0000${worktree.branch}`;
      if (!worktreeByRepositoryAndBranch.has(key)) {
        worktreeByRepositoryAndBranch.set(key, {
          id: worktree.id,
          highlightColor: worktree.highlightColor,
        });
      }
    }
    const managedByName = new Map(
      managedRepositories.map((repository) => [
        repository.nameWithOwner.toLowerCase(),
        repository,
      ]),
    );
    const defaultGitHubRegex =
      settings?.defaultJiraKeyRegex ?? DEFAULT_JIRA_KEY_REGEX;
    const defaultBranchRegex =
      codebaseSettings?.defaultJiraBranchRegex ?? DEFAULT_JIRA_KEY_REGEX;
    const appConfigured = appSettings !== null;
    const pullRequestNumbersByRun = await Promise.all(
      selectedRuns.map(({ run, target }) =>
        this.actionsPullRequestNumbers(run, target, token, requestSource),
      ),
    );
    const items: GitHubActionsWorkflowRunView[] = selectedRuns.map(
      ({ run, target }, index) => {
        const completed = run.status.toLowerCase() === "completed";
        const checkSuiteId = run.check_suite_node_id || null;
        const retryUnavailableReason = !completed
          ? "NOT_COMPLETED"
          : !checkSuiteId
            ? "WORKFLOW_RUN_UNAVAILABLE"
            : appConfigured
              ? null
              : "GITHUB_APP_NOT_CONFIGURED";
        const titleRegex =
          managedByName.get(target.nameWithOwner.toLowerCase())?.jiraKeyRegex ??
          defaultGitHubRegex;
        const branchRegex = target.jiraBranchRegex ?? defaultBranchRegex;
        const pullRequestNumbers = pullRequestNumbersByRun[index] ?? [];
        const worktreeHighlight = run.head_branch
          ? (worktreeByRepositoryAndBranch.get(
              `${target.id}\u0000${run.head_branch}`,
            ) ?? null)
          : null;
        return {
          id: String(run.id),
          workflowId: String(run.workflow_id ?? run.name ?? run.id),
          repositoryGithubId: run.repository.node_id,
          codebaseRepositoryId: target.id,
          repositoryNameWithOwner: target.nameWithOwner,
          repositoryUrl: target.url,
          name: run.name?.trim() || "GitHub Actions",
          displayTitle: run.display_title?.trim() || run.name || "Workflow run",
          runNumber: run.run_number,
          runAttempt: run.run_attempt ?? 1,
          event: run.event,
          status: pipelineState(run.status, run.conclusion),
          url: run.html_url,
          headBranch: run.head_branch,
          headSha: run.head_sha,
          checkSuiteId,
          canRetry: retryUnavailableReason === null,
          retryUnavailableReason,
          pullRequests: pullRequestNumbers.map((number) => ({
            number,
            url: `${target.url}/pull/${number}`,
          })),
          jiraKey:
            parseJiraKey(run.display_title, titleRegex) ??
            parseJiraKey(run.head_branch ?? "", branchRegex),
          worktreeId: worktreeHighlight?.id ?? null,
          worktreeHighlightColor: worktreeHighlight?.highlightColor ?? null,
          startedAt: run.run_started_at ?? run.created_at,
          createdAt: run.created_at,
          updatedAt: run.updated_at,
        };
      },
    );
    const canonicalRecords = await this.pipelineStatus.observeWorkflowRuns(
      items,
      "REST",
      false,
    );
    const canonicalItems = items.map((item) => {
      const record = canonicalRecords.get(item.id);
      return record
        ? {
            ...item,
            status: record.status,
            checkSuiteId: record.checkSuiteId,
            canRetry: record.canRetry,
            retryUnavailableReason: record.retryUnavailableReason,
            runAttempt: record.runAttempt ?? item.runAttempt,
          }
        : item;
    });
    const hasNextPage = streams.some(
      (stream) =>
        !stream.failed &&
        (stream.current !== null || stream.consumed < stream.totalCount),
    );
    const endCursor = hasNextPage
      ? encodeActionsCursor({
          version: 1,
          codebaseRepositoryId: selectedRepositoryId,
          branch: selectedBranch,
          workflowId: selectedWorkflowId,
          consumed: Object.fromEntries(
            streams.map((stream) => [stream.target.id, stream.consumed]),
          ),
        })
      : null;
    return {
      items: canonicalItems,
      repositories: repositories.map(({ id, nameWithOwner, url }) => ({
        id,
        nameWithOwner,
        url,
      })),
      repositoryErrors,
      hasNextPage,
      endCursor,
    };
  }

  async actionsWorkflowJobs(
    codebaseRepositoryId: string,
    workflowRunId: string,
    requestSource: GitHubRequestSource = "ACTIONS_PAGE",
  ): Promise<GitHubWorkflowJobView[]> {
    if (!codebaseRepositoryId.trim() || !workflowRunId.trim()) {
      throw new Error("Codebase repository and workflow run IDs are required");
    }
    const prisma = await getPrismaClient();
    const repository = await prisma.codebaseRepository.findUnique({
      where: { id: codebaseRepositoryId },
      select: {
        id: true,
        canonicalOrigin: true,
        jiraBranchRegex: true,
      },
    });
    const target = repository ? actionsRepositoryTarget(repository) : null;
    if (!target) throw new Error("GitHub codebase repository was not found");
    const [token, appSettings] = await Promise.all([
      this.requireToken(),
      prisma.gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
      }),
    ]);
    const jobs = await this.patWorkflowJobs(
      target.owner,
      target.name,
      workflowRunId,
      token,
      "latest",
      requestSource,
    );
    const views = this.workflowJobViews(jobs, appSettings !== null);
    await this.pipelineStatus.observeJobs(null, workflowRunId, views, "REST");
    return views;
  }

  private async actionsTargetByIdentifier(
    identifier: string,
  ): Promise<ActionsRepositoryTarget> {
    const prisma = await getPrismaClient();
    const codebaseRepository = await prisma.codebaseRepository.findUnique({
      where: { id: identifier },
      select: { id: true, canonicalOrigin: true, jiraBranchRegex: true },
    });
    const direct = codebaseRepository
      ? actionsRepositoryTarget(codebaseRepository)
      : null;
    if (direct) return direct;

    const githubRepository = await prisma.gitHubRepository.findUnique({
      where: { githubId: identifier },
    });
    if (!githubRepository) {
      throw new Error("GitHub repository was not found");
    }
    const canonicalOrigin = `github.com/${githubRepository.nameWithOwner.toLowerCase()}`;
    const logical = await prisma.codebaseRepository.findUnique({
      where: { canonicalOrigin },
      select: { id: true, jiraBranchRegex: true },
    });
    return {
      id: logical?.id ?? githubRepository.id,
      owner: githubRepository.owner,
      name: githubRepository.name,
      nameWithOwner: githubRepository.nameWithOwner,
      url: githubRepository.url,
      jiraBranchRegex: logical?.jiraBranchRegex ?? null,
    };
  }

  async autoRetryRepositoryId(identifier: string): Promise<string> {
    return (await this.actionsTargetByIdentifier(identifier)).id;
  }

  async autoRetryCredentialsReady(): Promise<boolean> {
    const prisma = await getPrismaClient();
    const appSettings = await prisma.gitHubAppSettings.findUnique({
      where: { id: GITHUB_APP_SETTINGS_ID },
    });
    const [tokenConfigured, appKeyConfigured] = await Promise.all([
      this.credentials.isConfigured(CREDENTIALS.githubPersonalAccessToken),
      this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey),
    ]);
    return Boolean(
      tokenConfigured &&
      appKeyConfigured &&
      appSettings &&
      appSettings.actionsPermission === "write",
    );
  }

  private async patWorkflowAttemptJobs(
    target: ActionsRepositoryTarget,
    workflowRunId: string,
    attempt: number,
    token: string,
    requestSource: GitHubRequestSource,
  ): Promise<GitHubActionsWorkflowJob[]> {
    const jobs: GitHubActionsWorkflowJob[] = [];
    let page = 1;
    let totalCount = 0;
    do {
      const result = await this.restRequest<{
        total_count: number;
        jobs: GitHubActionsWorkflowJob[];
      }>(
        `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
          target.name,
        )}/actions/runs/${encodeURIComponent(workflowRunId)}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
        GITHUB_REST_OPERATIONS.actions.listJobsForWorkflowRunAttempt,
        token,
        requestSource,
      );
      totalCount = result.total_count;
      jobs.push(...result.jobs);
      page += 1;
    } while (jobs.length < totalCount);
    return jobs;
  }

  async actionsWorkflowRunAttempt(
    repositoryId: string,
    workflowRunId: string,
    attempt: number,
    includeJobs = true,
    requestSource: GitHubRequestSource = "ACTIONS_PAGE",
  ): Promise<GitHubWorkflowRunAttemptView> {
    if (!repositoryId.trim() || !workflowRunId.trim()) {
      throw new Error("Repository and workflow run IDs are required");
    }
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error("Attempt must be a positive integer");
    }
    const [target, token, appSettings] = await Promise.all([
      this.actionsTargetByIdentifier(repositoryId),
      this.requireToken(),
      includeJobs
        ? (await getPrismaClient()).gitHubAppSettings.findUnique({
            where: { id: GITHUB_APP_SETTINGS_ID },
          })
        : null,
    ]);
    const run = await this.restRequest<RawActionsWorkflowRun>(
      `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
        target.name,
      )}/actions/runs/${encodeURIComponent(workflowRunId)}/attempts/${attempt}`,
      GITHUB_REST_OPERATIONS.actions.getWorkflowRunAttempt,
      token,
      requestSource,
    );
    const jobs = includeJobs
      ? await this.patWorkflowAttemptJobs(
          target,
          workflowRunId,
          attempt,
          token,
          requestSource,
        )
      : [];
    const appConfigured =
      Boolean(appSettings) &&
      (await this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey));
    const jobViews = this.workflowJobViews(jobs, appConfigured).map((job) => ({
      ...job,
      canRetry: false,
      retryUnavailableReason: "HISTORICAL_ATTEMPT" as const,
    }));
    const runAttempt = run.run_attempt ?? attempt;
    const status = pipelineState(run.status, run.conclusion);
    await this.pipelineStatus.observeSnapshot({
      repositoryGithubId: run.repository.node_id,
      repositoryNameWithOwner: run.repository.full_name,
      repositoryUrl: run.repository.html_url,
      headSha: run.head_sha,
      pipelines: [
        {
          id: String(run.id),
          name: run.name?.trim() || "GitHub Actions",
          status,
          url: run.html_url,
          checkSuiteId: run.check_suite_node_id || null,
          workflowRunId,
          workflowId: String(run.workflow_id ?? run.name ?? run.id),
          runNumber: run.run_number,
          runAttempt,
          canRetry: false,
          retryUnavailableReason: "HISTORICAL_ATTEMPT",
          jobs: includeJobs ? jobViews : undefined,
          source: "REST",
          githubUpdatedAt: new Date(run.updated_at),
          isCurrent: false,
        },
      ],
    });
    return {
      workflowRunId,
      runAttempt,
      status,
      url: run.html_url,
      triggeringActor: run.triggering_actor
        ? {
            login: run.triggering_actor.login,
            avatarUrl: run.triggering_actor.avatar_url,
            url: run.triggering_actor.html_url,
          }
        : run.actor
          ? {
              login: run.actor.login,
              avatarUrl: run.actor.avatar_url,
              url: run.actor.html_url,
            }
          : null,
      startedAt: run.run_started_at ?? run.created_at,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      jobs: jobViews,
    };
  }

  async worktreeWorkflowRuns(
    worktreeId: string,
  ): Promise<GitHubActionsWorkflowRunView[]> {
    if (!worktreeId.trim()) throw new Error("Worktree ID is required");
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findUnique({
      where: { id: worktreeId },
      select: {
        id: true,
        branch: true,
        headSha: true,
        highlightColor: true,
        codebase: {
          select: {
            repository: {
              select: {
                id: true,
                canonicalOrigin: true,
                jiraBranchRegex: true,
              },
            },
          },
        },
      },
    });
    if (!worktree?.headSha) return [];
    const target = actionsRepositoryTarget(worktree.codebase.repository);
    if (!target) return [];
    const [token, appSettings] = await Promise.all([
      this.requireToken(),
      prisma.gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
      }),
    ]);
    const result = await this.restRequest<{
      workflow_runs: RawActionsWorkflowRun[];
    }>(
      `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
        target.name,
      )}/actions/runs?head_sha=${encodeURIComponent(worktree.headSha)}&per_page=100`,
      GITHUB_REST_OPERATIONS.actions.listWorkflowRunsForRepo,
      token,
      "WORKTREE_PIPELINES",
    );
    let runs = result.workflow_runs;
    if (runs.length === 0 && worktree.branch) {
      const branchResult = await this.restRequest<{
        workflow_runs: RawActionsWorkflowRun[];
      }>(
        `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
          target.name,
        )}/actions/runs?branch=${encodeURIComponent(worktree.branch)}&per_page=100`,
        GITHUB_REST_OPERATIONS.actions.listWorkflowRunsForRepo,
        token,
        "WORKTREE_PIPELINES",
      );
      const latestRemoteSha = branchResult.workflow_runs[0]?.head_sha;
      runs = latestRemoteSha
        ? branchResult.workflow_runs.filter(
            (run) => run.head_sha === latestRemoteSha,
          )
        : [];
    }
    const views: GitHubActionsWorkflowRunView[] = runs.map((run) => {
      const completed = run.status.toLowerCase() === "completed";
      const checkSuiteId = run.check_suite_node_id || null;
      const unavailable = !completed
        ? "NOT_COMPLETED"
        : !checkSuiteId
          ? "WORKFLOW_RUN_UNAVAILABLE"
          : appSettings
            ? null
            : "GITHUB_APP_NOT_CONFIGURED";
      return {
        id: String(run.id),
        workflowId: String(run.workflow_id ?? run.name ?? run.id),
        repositoryGithubId: run.repository.node_id,
        codebaseRepositoryId: target.id,
        repositoryNameWithOwner: target.nameWithOwner,
        repositoryUrl: target.url,
        name: run.name?.trim() || "GitHub Actions",
        displayTitle: run.display_title?.trim() || run.name || "Workflow run",
        runNumber: run.run_number,
        runAttempt: run.run_attempt ?? 1,
        event: run.event,
        status: pipelineState(run.status, run.conclusion),
        url: run.html_url,
        headBranch: run.head_branch,
        headSha: run.head_sha,
        checkSuiteId,
        canRetry: unavailable === null,
        retryUnavailableReason: unavailable,
        pullRequests: (run.pull_requests ?? []).map(({ number }) => ({
          number,
          url: `${target.url}/pull/${number}`,
        })),
        jiraKey: null,
        worktreeId: worktree.id,
        worktreeHighlightColor: worktree.highlightColor,
        startedAt: run.run_started_at ?? run.created_at,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      };
    });
    const canonicalRecords = await this.pipelineStatus.observeWorkflowRuns(
      views,
      "REST",
    );
    return views.map((view) => {
      const record = canonicalRecords.get(view.id);
      return record
        ? {
            ...view,
            status: record.status,
            checkSuiteId: record.checkSuiteId,
            canRetry: record.canRetry,
            retryUnavailableReason: record.retryUnavailableReason,
            runAttempt: record.runAttempt ?? view.runAttempt,
          }
        : view;
    });
  }

  async repositoryWorkflows(
    codebaseRepositoryId: string,
    requestSource: GitHubRequestSource = "ACTIONS_PAGE",
  ): Promise<GitHubRepositoryWorkflowView[]> {
    const target = await this.actionsTargetByIdentifier(codebaseRepositoryId);
    const token = await this.requireToken();
    const workflows: RawRepositoryWorkflow[] = [];
    let page = 1;
    let totalCount = 0;
    do {
      const result = await this.restRequest<{
        total_count: number;
        workflows: RawRepositoryWorkflow[];
      }>(
        `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
          target.name,
        )}/actions/workflows?per_page=100&page=${page}`,
        GITHUB_REST_OPERATIONS.actions.listRepoWorkflows,
        token,
        requestSource,
      );
      totalCount = result.total_count;
      workflows.push(...result.workflows);
      page += 1;
    } while (workflows.length < totalCount);

    return Promise.all(
      workflows.map(async (workflow) => {
        const latest = await this.restRequest<{
          workflow_runs: RawActionsWorkflowRun[];
        }>(
          `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
            target.name,
          )}/actions/workflows/${encodeURIComponent(String(workflow.id))}/runs?per_page=1`,
          GITHUB_REST_OPERATIONS.actions.listWorkflowRuns,
          token,
          requestSource,
        );
        const run = latest.workflow_runs[0];
        const jobs = run
          ? await this.patWorkflowJobs(
              target.owner,
              target.name,
              String(run.id),
              token,
              "latest",
              requestSource,
            )
          : [];
        return {
          id: String(workflow.id),
          name: workflow.name,
          path: workflow.path,
          state: workflow.state,
          url: workflow.html_url,
          jobNames: [...new Set(jobs.map((job) => job.name))].sort(),
        };
      }),
    );
  }

  async autoRetryRuns(
    repositoryId: string,
  ): Promise<
    Array<GitHubActionsWorkflowRunView & { jobs: GitHubWorkflowJobView[] }>
  > {
    const [target, token, appSettings] = await Promise.all([
      this.actionsTargetByIdentifier(repositoryId),
      this.requireToken(),
      (await getPrismaClient()).gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
      }),
    ]);
    const result = await this.restRequest<{
      workflow_runs: RawActionsWorkflowRun[];
    }>(
      `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
        target.name,
      )}/actions/runs?per_page=100`,
      GITHUB_REST_OPERATIONS.actions.listWorkflowRunsForRepo,
      token,
      "AUTO_RETRY",
    );
    const items: Array<
      GitHubActionsWorkflowRunView & { jobs: GitHubWorkflowJobView[] }
    > = result.workflow_runs.map((run) => {
      const completed = run.status.toLowerCase() === "completed";
      const checkSuiteId = run.check_suite_node_id || null;
      const unavailable = !completed
        ? "NOT_COMPLETED"
        : !checkSuiteId
          ? "WORKFLOW_RUN_UNAVAILABLE"
          : appSettings
            ? null
            : "GITHUB_APP_NOT_CONFIGURED";
      const pullRequestNumbers = [
        ...new Set((run.pull_requests ?? []).map(({ number }) => number)),
      ];
      return {
        id: String(run.id),
        workflowId: String(run.workflow_id ?? run.name ?? run.id),
        repositoryGithubId: run.repository.node_id,
        codebaseRepositoryId: target.id,
        repositoryNameWithOwner: target.nameWithOwner,
        repositoryUrl: target.url,
        name: run.name?.trim() || "GitHub Actions",
        displayTitle: run.display_title?.trim() || run.name || "Workflow run",
        runNumber: run.run_number,
        runAttempt: run.run_attempt ?? 1,
        event: run.event,
        status: pipelineState(run.status, run.conclusion),
        url: run.html_url,
        headBranch: run.head_branch,
        headSha: run.head_sha,
        checkSuiteId,
        canRetry: unavailable === null,
        retryUnavailableReason: unavailable,
        pullRequests: pullRequestNumbers.map((number) => ({
          number,
          url: `${target.url}/pull/${number}`,
        })),
        jiraKey: null,
        worktreeId: null,
        worktreeHighlightColor: null,
        startedAt: run.run_started_at ?? run.created_at,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        jobs: [],
      };
    });
    const canonical = await this.pipelineStatus.observeWorkflowRuns(
      items,
      "REST",
      false,
    );
    return items.map((item) => {
      const record = canonical.get(item.id);
      return record
        ? {
            ...item,
            status: record.status,
            checkSuiteId: record.checkSuiteId,
            canRetry: record.canRetry,
            retryUnavailableReason: record.retryUnavailableReason,
            runAttempt: record.runAttempt ?? item.runAttempt,
            jobs: record.jobs,
          }
        : item;
    });
  }

  async autoRetryRun(
    repositoryId: string,
    workflowRunId: string,
    includeJobs = true,
    requestSource: GitHubRequestSource = "AUTO_RETRY",
  ): Promise<GitHubActionsWorkflowRunView & { jobs: GitHubWorkflowJobView[] }> {
    const [target, token, appSettings] = await Promise.all([
      this.actionsTargetByIdentifier(repositoryId),
      this.requireToken(),
      (await getPrismaClient()).gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
      }),
    ]);
    const run = await this.restRequest<RawActionsWorkflowRun>(
      `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
        target.name,
      )}/actions/runs/${encodeURIComponent(workflowRunId)}`,
      GITHUB_REST_OPERATIONS.actions.getWorkflowRun,
      token,
      requestSource,
    );
    const completed = run.status.toLowerCase() === "completed";
    const jobs =
      completed && includeJobs
        ? await this.patWorkflowJobs(
            target.owner,
            target.name,
            workflowRunId,
            token,
            "all",
            requestSource,
          )
        : [];
    const checkSuiteId = run.check_suite_node_id || null;
    const appConfigured =
      Boolean(appSettings) &&
      (await this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey));
    const unavailable = !completed
      ? "NOT_COMPLETED"
      : !checkSuiteId
        ? "WORKFLOW_RUN_UNAVAILABLE"
        : appConfigured
          ? null
          : "GITHUB_APP_NOT_CONFIGURED";
    const view: GitHubActionsWorkflowRunView & {
      jobs: GitHubWorkflowJobView[];
    } = {
      id: String(run.id),
      workflowId: String(run.workflow_id ?? run.name ?? run.id),
      repositoryGithubId: run.repository.node_id,
      codebaseRepositoryId: target.id,
      repositoryNameWithOwner: target.nameWithOwner,
      repositoryUrl: target.url,
      name: run.name?.trim() || "GitHub Actions",
      displayTitle: run.display_title?.trim() || run.name || "Workflow run",
      runNumber: run.run_number,
      runAttempt: run.run_attempt ?? 1,
      event: run.event,
      status: pipelineState(run.status, run.conclusion),
      url: run.html_url,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      checkSuiteId,
      canRetry: unavailable === null,
      retryUnavailableReason: unavailable,
      pullRequests: (run.pull_requests ?? []).map(({ number }) => ({
        number,
        url: `${target.url}/pull/${number}`,
      })),
      jiraKey: null,
      worktreeId: null,
      worktreeHighlightColor: null,
      startedAt: run.run_started_at ?? run.created_at,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      jobs: this.workflowJobViews(jobs, appConfigured)
        .sort((left, right) => (right.runAttempt ?? 0) - (left.runAttempt ?? 0))
        .filter(
          (job, index, items) =>
            items.findIndex((item) => item.name === job.name) === index,
        ),
    };
    const records = await this.pipelineStatus.observeWorkflowRuns(
      [view],
      "REST",
      false,
    );
    const canonical = includeJobs
      ? await this.pipelineStatus.observeJobs(
          view.repositoryGithubId,
          view.id,
          view.jobs,
          "REST",
          new Date(view.updatedAt),
        )
      : (records.get(view.id) ?? null);
    return canonical
      ? {
          ...view,
          status: canonical.status,
          checkSuiteId: canonical.checkSuiteId,
          canRetry: canonical.canRetry,
          retryUnavailableReason: canonical.retryUnavailableReason,
          runAttempt: canonical.runAttempt ?? view.runAttempt,
          jobs: canonical.jobs,
        }
      : view;
  }

  async autoRetryRerun(
    repositoryId: string,
    workflowRunId: string,
    action: "ALL_JOBS" | "FAILED_JOBS" | "JOB",
    jobId: string | null,
    auditContext: GitHubAuditContext,
  ): Promise<void> {
    const target = await this.actionsTargetByIdentifier(repositoryId);
    const prisma = await getPrismaClient();
    const appSettings = await prisma.gitHubAppSettings.findUnique({
      where: { id: GITHUB_APP_SETTINGS_ID },
    });
    if (!appSettings) throw new Error("GitHub App is not configured");
    const credentials = await this.appCredentials(appSettings);
    let githubRequestId: string | null = null;
    try {
      if (action === "JOB") {
        if (!jobId) throw new Error("Job ID is required");
        githubRequestId = (
          await rerunGitHubActionsJob(credentials, {
            owner: target.owner,
            repository: target.name,
            workflowRunId,
            jobId,
            requestSource: requestSourceFromAudit(auditContext),
          })
        ).githubRequestId;
      } else if (action === "FAILED_JOBS") {
        githubRequestId = (
          await rerunGitHubActionsFailedJobs(credentials, {
            owner: target.owner,
            repository: target.name,
            workflowRunId,
            requestSource: requestSourceFromAudit(auditContext),
          })
        ).githubRequestId;
      } else {
        githubRequestId = (
          await rerunGitHubActionsWorkflow(credentials, {
            owner: target.owner,
            repository: target.name,
            workflowRunId,
            requestSource: requestSourceFromAudit(auditContext),
          })
        ).githubRequestId;
      }
      await this.cache.clear();
      if (action === "JOB" && jobId) {
        await this.pipelineStatus.optimisticJobByWorkflowRun(
          null,
          workflowRunId,
          jobId,
        );
      } else {
        await this.pipelineStatus.optimisticByWorkflowRun(null, workflowRunId, {
          status: "QUEUED",
          jobs: [],
        });
      }
      await this.audit(auditContext, {
        operation:
          action === "JOB"
            ? "GITHUB_ACTIONS_AUTO_JOB_RERUN"
            : "GITHUB_ACTIONS_AUTO_WORKFLOW_RERUN",
        repositoryId,
        jobId,
        githubRequestId,
        outcome: "SUCCESS",
      });
    } catch (error) {
      await this.audit(auditContext, {
        operation:
          action === "JOB"
            ? "GITHUB_ACTIONS_AUTO_JOB_RERUN"
            : "GITHUB_ACTIONS_AUTO_WORKFLOW_RERUN",
        repositoryId,
        jobId,
        githubRequestId:
          error instanceof GitHubAppError ? error.githubRequestId : null,
        outcome: "FAILURE",
        errorCode:
          error instanceof GitHubAppError
            ? error.code
            : "GITHUB_APP_REQUEST_FAILED",
      });
      throw error;
    }
  }

  async cancelActionsWorkflowRun(
    codebaseRepositoryId: string,
    workflowRunId: string,
    force: boolean,
    requestSource: GitHubRequestSource,
    auditContext: GitHubAuditContext,
  ): Promise<boolean> {
    if (!codebaseRepositoryId.trim() || !workflowRunId.trim()) {
      throw new Error("Codebase repository and workflow run IDs are required");
    }
    const operation = force
      ? "GITHUB_ACTIONS_WORKFLOW_FORCE_CANCEL"
      : "GITHUB_ACTIONS_WORKFLOW_CANCEL";
    try {
      const prisma = await getPrismaClient();
      const repository = await prisma.codebaseRepository.findUnique({
        where: { id: codebaseRepositoryId },
        select: {
          id: true,
          canonicalOrigin: true,
          jiraBranchRegex: true,
        },
      });
      const target = repository ? actionsRepositoryTarget(repository) : null;
      if (!target) throw new Error("GitHub codebase repository was not found");
      const credentials = await this.requireAppCredentials();
      const result = await cancelGitHubActionsWorkflow(credentials, {
        owner: target.owner,
        repository: target.name,
        workflowRunId,
        force,
        requestSource,
      });
      await this.cache.clear();
      await this.pipelineStatus.optimisticByWorkflowRun(null, workflowRunId, {
        status: "CANCELLED",
      });
      await this.audit(auditContext, {
        operation,
        repositoryId: codebaseRepositoryId,
        githubRequestId: result.githubRequestId,
        outcome: "SUCCESS",
      });
      return true;
    } catch (error) {
      await this.audit(auditContext, {
        operation,
        repositoryId: codebaseRepositoryId,
        githubRequestId:
          error instanceof GitHubAppError ? error.githubRequestId : null,
        outcome: "FAILURE",
        errorCode:
          error instanceof GitHubAppError
            ? error.code
            : "GITHUB_APP_REQUEST_FAILED",
      });
      throw error;
    }
  }

  async addRepository(input: {
    nameWithOwner: string;
    jiraKeyRegex?: string | null;
  }): Promise<GitHubRepositoryView[]> {
    const { owner, name } = normalizeGitHubRepositoryName(input.nameWithOwner);
    const jiraKeyRegex = normalizeJiraKeyRegex(input.jiraKeyRegex);
    const token = await this.requireToken();
    const data = await this.request<{
      repository: {
        id: string;
        name: string;
        nameWithOwner: string;
        url: string;
        owner: { login: string };
      } | null;
    }>(
      `query GitHubRepository($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          id name nameWithOwner url owner { login }
        }
      }`,
      { owner, name },
      token,
      { requestSource: "PULL_REQUESTS_PAGE" },
    );
    if (!data.repository) {
      throw new Error("Repository was not found or is not accessible");
    }
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubRepository.findFirst({
      where: {
        OR: [
          { githubId: data.repository.id },
          { nameWithOwner: data.repository.nameWithOwner },
        ],
      },
    });
    if (existing) throw new Error("Repository is already managed");
    await prisma.gitHubRepository.create({
      data: {
        id: randomUUID(),
        githubId: data.repository.id,
        owner: data.repository.owner.login,
        name: data.repository.name,
        nameWithOwner: data.repository.nameWithOwner,
        url: data.repository.url,
        jiraKeyRegex,
      },
    });
    return this.listRepositories();
  }

  async updateRepository(input: {
    id: string;
    jiraKeyRegex?: string | null;
  }): Promise<GitHubRepositoryView[]> {
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubRepository.findUnique({
      where: { id: input.id },
    });
    if (!existing) throw new Error("Managed repository was not found");
    await prisma.gitHubRepository.update({
      where: { id: input.id },
      data: { jiraKeyRegex: normalizeJiraKeyRegex(input.jiraKeyRegex) },
    });
    return this.listRepositories();
  }

  async removeRepository(id: string): Promise<GitHubRepositoryView[]> {
    const prisma = await getPrismaClient();
    const result = await prisma.gitHubRepository.deleteMany({ where: { id } });
    if (result.count === 0) throw new Error("Managed repository was not found");
    return this.listRepositories();
  }

  private async remainingReviewComments(
    threadId: string,
    after: string,
    token: string,
    requestSource: GitHubRequestSource,
  ): Promise<RawReviewComment[]> {
    const comments: RawReviewComment[] = [];
    let cursor: string | null = after;
    while (cursor) {
      const data: {
        node: { comments: RawConnection<RawReviewComment> } | null;
      } = await this.request(
        `query GitHubReviewThreadComments($id: ID!, $after: String) {
          node(id: $id) {
            ... on PullRequestReviewThread {
              comments(first: 100, after: $after) {
                nodes { ${REVIEW_COMMENT_FIELDS} }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: threadId, after: cursor },
        token,
        { requestSource },
      );
      if (!data.node) break;
      comments.push(...connectionNodes(data.node.comments));
      cursor = data.node.comments.pageInfo.hasNextPage
        ? data.node.comments.pageInfo.endCursor
        : null;
    }
    return comments;
  }

  private async completeReviewThread(
    thread: RawReviewThread,
    token: string,
    requestSource: GitHubRequestSource,
  ): Promise<RawReviewThread> {
    const comments = connectionNodes(thread.comments);
    if (
      thread.comments.pageInfo.hasNextPage &&
      thread.comments.pageInfo.endCursor
    ) {
      comments.push(
        ...(await this.remainingReviewComments(
          thread.id,
          thread.comments.pageInfo.endCursor,
          token,
          requestSource,
        )),
      );
    }
    return {
      ...thread,
      comments: {
        nodes: comments,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  }

  private async completeReviewThreads(
    pullRequestId: string,
    initial: RawConnection<RawReviewThread>,
    token: string,
    requestSource: GitHubRequestSource,
    highlights?: Map<string, WorktreeHighlight>,
  ): Promise<GitHubReviewThread[]> {
    const threads = connectionNodes(initial);
    let cursor = initial.pageInfo.hasNextPage
      ? initial.pageInfo.endCursor
      : null;
    while (cursor) {
      const data: {
        node: { reviewThreads: RawConnection<RawReviewThread> } | null;
      } = await this.request(
        `query GitHubPullRequestReviewThreadDetails(
          $id: ID!
          $after: String
        ) {
          node(id: $id) {
            ... on PullRequest {
              reviewThreads(first: 100, after: $after) {
                nodes { ${REVIEW_THREAD_FIELDS} }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: pullRequestId, after: cursor },
        token,
        { requestSource },
      );
      if (!data.node) break;
      threads.push(...connectionNodes(data.node.reviewThreads));
      cursor = data.node.reviewThreads.pageInfo.hasNextPage
        ? data.node.reviewThreads.pageInfo.endCursor
        : null;
    }
    const normalized = await Promise.all(
      threads.map(async (thread) =>
        normalizeReviewThread(
          await this.completeReviewThread(thread, token, requestSource),
          highlights,
        ),
      ),
    );
    return normalized
      .filter((thread): thread is GitHubReviewThread => thread !== null)
      .sort(
        (left, right) =>
          Date.parse(right.rootComment.createdAt) -
          Date.parse(left.rootComment.createdAt),
      );
  }

  private async searchReviewPullRequestScopes(
    queries: string[],
    token: string,
  ): Promise<{
    searches: Array<{
      items: RawReviewPullRequestMetadata[];
      truncated: boolean;
    }>;
    viewerLogin: string;
  }> {
    const scopes = queries.map((query) => ({
      query,
      after: null as string | null,
      items: [] as RawReviewPullRequestMetadata[],
      done: false,
      truncated: false,
    }));
    let viewerLogin: string | null = null;
    while (scopes.some((scope) => !scope.done)) {
      const active = scopes
        .map((scope, index) => ({ scope, index }))
        .filter(({ scope }) => !scope.done);
      for (let start = 0; start < active.length; start += 10) {
        const batch = active.slice(start, start + 10);
        const definitions = batch
          .map(({ index }) => `$query${index}: String!, $after${index}: String`)
          .join(", ");
        const selections = batch
          .map(
            ({ index }) => `search${index}: search(
              query: $query${index}
              type: ISSUE
              first: 50
              after: $after${index}
            ) {
              nodes {
                ... on PullRequest {
                  id
                  number
                  title
                  url
                  updatedAt
                  headRefName
                  headRepository { nameWithOwner }
                  repository { nameWithOwner }
                }
              }
              pageInfo { hasNextPage endCursor }
            }`,
          )
          .join("\n");
        const variables = Object.fromEntries(
          batch.flatMap(({ scope, index }) => [
            [`query${index}`, scope.query],
            [`after${index}`, scope.after],
          ]),
        );
        const data: Record<string, unknown> & {
          viewer?: { login: string };
        } = await this.request(
          `query GitHubReviewThreadPullRequestSearch(${definitions}) {
            ${viewerLogin ? "" : "viewer { login }"}
            ${selections}
          }`,
          variables,
          token,
          { requestSource: "COMMENTS_PAGE" },
        );
        viewerLogin ??= data.viewer?.login ?? null;
        for (const { scope, index } of batch) {
          const connection = data[`search${index}`] as
            RawConnection<RawReviewPullRequestMetadata> | undefined;
          if (!connection) {
            scope.done = true;
            continue;
          }
          scope.items.push(...connectionNodes(connection));
          if (scope.items.length >= SEARCH_RESULT_LIMIT) {
            scope.items = scope.items.slice(0, SEARCH_RESULT_LIMIT);
            scope.truncated = connection.pageInfo.hasNextPage;
            scope.done = true;
          } else if (
            connection.pageInfo.hasNextPage &&
            connection.pageInfo.endCursor
          ) {
            scope.after = connection.pageInfo.endCursor;
          } else {
            scope.done = true;
          }
        }
      }
    }
    if (!viewerLogin) throw new Error("GitHub did not return the viewer");
    return {
      searches: scopes.map(({ items, truncated }) => ({ items, truncated })),
      viewerLogin,
    };
  }

  private async hydrateReviewPullRequests(
    pullRequests: RawReviewPullRequestMetadata[],
    token: string,
  ): Promise<RawReviewPullRequest[]> {
    const hydrated: RawReviewPullRequest[] = [];
    for (let index = 0; index < pullRequests.length; index += 50) {
      const batch = pullRequests.slice(index, index + 50);
      const data = await this.request<{
        nodes: Array<{
          id: string;
          reviewThreads: RawConnection<RawReviewThread>;
        } | null>;
      }>(
        `query GitHubReviewThreadDetails($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on PullRequest {
              id
              reviewThreads(first: 50) {
                nodes { ${REVIEW_THREAD_FIELDS} }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { ids: batch.map((pullRequest) => pullRequest.id) },
        token,
        { requestSource: "COMMENTS_PAGE" },
      );
      const connections = new Map(
        data.nodes
          .filter(
            (
              node,
            ): node is {
              id: string;
              reviewThreads: RawConnection<RawReviewThread>;
            } => node !== null,
          )
          .map((node) => [node.id, node.reviewThreads]),
      );
      for (const pullRequest of batch) {
        const reviewThreads = connections.get(pullRequest.id);
        if (reviewThreads) hydrated.push({ ...pullRequest, reviewThreads });
      }
    }
    return hydrated;
  }

  private async searchPullRequestPage(
    query: string,
    token: string,
    after: string | null,
    requestSource: GitHubRequestSource,
  ): Promise<RawConnection<RawPullRequest>> {
    return (
      await this.searchPullRequestPages(
        [{ query, after }],
        token,
        requestSource,
      )
    )[0]!;
  }

  private async searchPullRequestPages(
    requests: Array<{ query: string; after: string | null }>,
    token: string,
    requestSource: GitHubRequestSource,
  ): Promise<RawConnection<RawPullRequest>[]> {
    if (requests.length === 1) {
      const data = await this.request<{
        search: RawConnection<RawPullRequest>;
      }>(
        `query GitHubPullRequestSearch($query: String!, $after: String) {
          search(
            query: $query
            type: ISSUE
            first: ${PULL_REQUEST_PAGE_SIZE}
            after: $after
          ) {
            nodes { ...PullRequestTableFields }
            pageInfo { hasNextPage endCursor }
          }
        }
        ${PULL_REQUEST_FRAGMENT}`,
        requests[0]!,
        token,
        { requestSource },
      );
      return [data.search];
    }
    const definitions = requests
      .map((_, index) => `$query${index}: String!, $after${index}: String`)
      .join(", ");
    const selections = requests
      .map(
        (_, index) => `search${index}: search(
          query: $query${index}
          type: ISSUE
          first: ${PULL_REQUEST_PAGE_SIZE}
          after: $after${index}
        ) {
          nodes { ...PullRequestTableFields }
          pageInfo { hasNextPage endCursor }
        }`,
      )
      .join("\n");
    const variables = Object.fromEntries(
      requests.flatMap((request, index) => [
        [`query${index}`, request.query],
        [`after${index}`, request.after],
      ]),
    );
    const data = await this.request<
      Record<string, RawConnection<RawPullRequest>>
    >(
      `query GitHubPullRequestSearch(${definitions}) {
        ${selections}
      }
      ${PULL_REQUEST_FRAGMENT}`,
      variables,
      token,
      { requestSource },
    );
    return requests.map((_, index) => data[`search${index}`]!);
  }

  private async repositoryPullRequestPage(
    repository: GitHubRepositoryView,
    token: string,
    state: GitHubPullRequestStateFilter,
    after: string | null,
    requestSource: GitHubRequestSource,
  ): Promise<RawConnection<RawPullRequest>> {
    const data: {
      repository: {
        pullRequests: RawConnection<RawPullRequest>;
      } | null;
    } = await this.request(
      `query GitHubRepositoryPullRequests(
        $owner: String!
        $name: String!
        $states: [PullRequestState!]!
        $after: String
      ) {
        repository(owner: $owner, name: $name) {
          pullRequests(
            states: $states
            first: ${PULL_REQUEST_PAGE_SIZE}
            after: $after
            orderBy: { field: UPDATED_AT, direction: DESC }
          ) {
            nodes { ...PullRequestTableFields }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      ${PULL_REQUEST_FRAGMENT}`,
      {
        owner: repository.owner,
        name: repository.name,
        states: state === "ALL" ? ["OPEN", "CLOSED", "MERGED"] : [state],
        after,
      },
      token,
      { requestSource },
    );
    if (!data.repository) {
      throw new Error("Managed repository was not found or is not accessible");
    }
    return data.repository.pullRequests;
  }

  private async repositoryPullRequests(
    repository: GitHubRepositoryView,
    token: string,
    requestSource: GitHubRequestSource,
  ): Promise<RawPullRequest[]> {
    const items: RawPullRequest[] = [];
    let after: string | null = null;
    while (true) {
      const connection = await this.repositoryPullRequestPage(
        repository,
        token,
        "OPEN",
        after,
        requestSource,
      );
      items.push(...connectionNodes(connection));
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) {
        return items;
      }
      after = connection.pageInfo.endCursor;
    }
  }

  private async remainingLabels(
    pullRequestId: string,
    after: string,
    token: string,
    requestSource: GitHubRequestSource,
    options: GitHubQueryOptions = {},
  ): Promise<string[]> {
    const labels: string[] = [];
    let cursor: string | null = after;
    while (cursor) {
      const data: {
        node: { labels: RawConnection<{ name: string }> } | null;
      } = await this.request(
        `query GitHubPullRequestLabels($id: ID!, $after: String) {
          node(id: $id) {
            ... on PullRequest {
              labels(first: 100, after: $after) {
                nodes { name }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: pullRequestId, after: cursor },
        token,
        { requestSource, ...options },
      );
      if (!data.node) break;
      labels.push(
        ...connectionNodes(data.node.labels).map((label) => label.name),
      );
      cursor = data.node.labels.pageInfo.hasNextPage
        ? data.node.labels.pageInfo.endCursor
        : null;
    }
    return labels;
  }

  private async remainingUnresolvedThreads(
    pullRequestId: string,
    after: string,
    token: string,
    requestSource: GitHubRequestSource,
    options: GitHubQueryOptions = {},
  ): Promise<number> {
    let count = 0;
    let cursor: string | null = after;
    while (cursor) {
      const data: {
        node: {
          reviewThreads: RawConnection<{ isResolved: boolean }>;
        } | null;
      } = await this.request(
        `query GitHubPullRequestReviewThreads($id: ID!, $after: String) {
          node(id: $id) {
            ... on PullRequest {
              reviewThreads(first: 100, after: $after) {
                nodes { isResolved }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: pullRequestId, after: cursor },
        token,
        { requestSource, ...options },
      );
      if (!data.node) break;
      count += connectionNodes(data.node.reviewThreads).filter(
        (thread) => !thread.isResolved,
      ).length;
      cursor = data.node.reviewThreads.pageInfo.hasNextPage
        ? data.node.reviewThreads.pageInfo.endCursor
        : null;
    }
    return count;
  }

  private async remainingPipelineContexts(
    pullRequestId: string,
    after: string,
    token: string,
    requestSource: GitHubRequestSource,
    options: GitHubQueryOptions = {},
  ): Promise<RawPipelineContext[]> {
    const contexts: RawPipelineContext[] = [];
    let cursor: string | null = after;
    while (cursor) {
      const data: {
        node: {
          statusCheckRollup: {
            contexts: RawConnection<RawPipelineContext>;
          } | null;
        } | null;
      } = await this.request(
        `query GitHubPullRequestPipelineContexts($id: ID!, $after: String) {
          node(id: $id) {
            ... on PullRequest {
              statusCheckRollup {
                contexts(first: 100, after: $after) {
                  nodes { ${PIPELINE_CONTEXT_FIELDS} }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        }`,
        { id: pullRequestId, after: cursor },
        token,
        { requestSource, ...options },
      );
      const connection = data.node?.statusCheckRollup?.contexts;
      if (!connection) break;
      contexts.push(...connectionNodes(connection));
      cursor = connection.pageInfo.hasNextPage
        ? connection.pageInfo.endCursor
        : null;
    }
    return contexts;
  }

  private async normalizePullRequestLiveStatus(
    pullRequest: RawPullRequestLiveStatus,
    token: string,
    appConfigured: boolean,
    requestSource: GitHubRequestSource,
    options: GitHubQueryOptions = {},
  ): Promise<GitHubPullRequestLiveStatus> {
    let unresolvedReviewThreadCount = connectionNodes(
      pullRequest.reviewThreads,
    ).filter((thread) => !thread.isResolved).length;
    if (
      pullRequest.reviewThreads.pageInfo.hasNextPage &&
      pullRequest.reviewThreads.pageInfo.endCursor
    ) {
      unresolvedReviewThreadCount += await this.remainingUnresolvedThreads(
        pullRequest.id,
        pullRequest.reviewThreads.pageInfo.endCursor,
        token,
        requestSource,
        options,
      );
    }
    const pipelineContexts = pullRequest.statusCheckRollup
      ? connectionNodes(pullRequest.statusCheckRollup.contexts)
      : [];
    if (
      pullRequest.statusCheckRollup?.contexts.pageInfo.hasNextPage &&
      pullRequest.statusCheckRollup.contexts.pageInfo.endCursor
    ) {
      pipelineContexts.push(
        ...(await this.remainingPipelineContexts(
          pullRequest.id,
          pullRequest.statusCheckRollup.contexts.pageInfo.endCursor,
          token,
          requestSource,
          options,
        )),
      );
    }
    const normalizedPipelineStatus = pipelineStatus(
      pullRequest.statusCheckRollup?.state,
    );
    const sourceFetchedAt =
      this.graphqlFetchedAt.get(pullRequest) ??
      graphqlPipelineFetchedAt(pullRequest, pipelineContexts);
    const canonical = await this.pipelineStatus.observeSnapshot({
      repositoryGithubId: pullRequest.repository.id,
      repositoryNameWithOwner: pullRequest.repository.nameWithOwner,
      repositoryUrl: pullRequest.repository.url,
      headSha: pullRequest.headRefOid,
      graphqlRollupStatus: normalizedPipelineStatus,
      sourceFetchedAt,
      completeGraphqlRollup: true,
      pipelines: pipelineContexts.map((context) =>
        pipelineObservationFromContext(
          context,
          appConfigured,
          this.graphqlFetchedAt.get(context) ?? sourceFetchedAt,
        ),
      ),
    });
    return {
      id: pullRequest.id,
      pipelineStatus: canonical.snapshot.pipelineStatus,
      pipelines: canonical.snapshot.pipelines,
      pipelineRevision: canonical.snapshot.revision,
      reviewDecision: reviewDecision(pullRequest.reviewDecision),
      unresolvedReviewThreadCount,
      state: pullRequest.mergedAt ? "MERGED" : pullRequest.state,
      isDraft: pullRequest.isDraft,
      mergeable: pullRequest.mergeable,
      mergeStateStatus: pullRequest.mergeStateStatus,
      autoMergeEnabled: Boolean(pullRequest.autoMergeRequest),
      viewerCanEnableAutoMerge: Boolean(pullRequest.viewerCanEnableAutoMerge),
      viewerCanDisableAutoMerge: Boolean(pullRequest.viewerCanDisableAutoMerge),
      headRefOid: pullRequest.headRefOid,
    };
  }

  private async normalizePullRequest(
    pullRequest: RawPullRequest,
    jiraKeyRegex: string | null,
    token: string,
    appConfigured: boolean,
    requestSource: GitHubRequestSource,
    options: GitHubQueryOptions = {},
  ): Promise<GitHubPullRequestView> {
    const labels = connectionNodes(pullRequest.labels).map(
      (label) => label.name,
    );
    if (
      pullRequest.labels.pageInfo.hasNextPage &&
      pullRequest.labels.pageInfo.endCursor
    ) {
      labels.push(
        ...(await this.remainingLabels(
          pullRequest.id,
          pullRequest.labels.pageInfo.endCursor,
          token,
          requestSource,
          options,
        )),
      );
    }
    const live = await this.normalizePullRequestLiveStatus(
      pullRequest,
      token,
      appConfigured,
      requestSource,
      options,
    );
    return {
      ...live,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      repositoryGithubId: pullRequest.repository.id,
      repositoryNameWithOwner: pullRequest.repository.nameWithOwner,
      repositoryUrl: pullRequest.repository.url,
      labels,
      jiraKey: parseJiraKey(pullRequest.title, jiraKeyRegex),
      headRefName: pullRequest.headRefName,
      // Callers that show the pull request alongside its worktree overlay the
      // tint from `worktreeHighlights`; on its own a pull request carries no
      // link to one.
      worktreeId: null,
      worktreeHighlightColor: null,
      createdAt: pullRequest.createdAt,
    };
  }

  /**
   * The worktree tint a GitHub surface paints is keyed by the branch's own
   * repository plus branch name, because that pair is all a pull request,
   * review thread, and Actions run carry in common. Resolving the colour live
   * rather than snapshotting it keeps recolouring a worktree from stranding the
   * rows pointing at it on the old tint.
   */
  private async worktreeHighlights(
    branches: Array<{ nameWithOwner: string | null; branch: string | null }>,
  ): Promise<Map<string, WorktreeHighlight>> {
    const origins = new Set<string>();
    const names = new Set<string>();
    for (const { nameWithOwner, branch } of branches) {
      if (!nameWithOwner || !branch) continue;
      origins.add(canonicalOriginOf(nameWithOwner));
      names.add(branch);
    }
    const highlights = new Map<string, WorktreeHighlight>();
    if (!origins.size) return highlights;
    const prisma = await getPrismaClient();
    const repositories = await prisma.codebaseRepository.findMany({
      where: { canonicalOrigin: { in: [...origins] } },
      select: { id: true, canonicalOrigin: true },
    });
    if (!repositories.length) return highlights;
    const worktrees = await prisma.worktree.findMany({
      where: {
        missingAt: null,
        branch: { in: [...names] },
        codebase: { repositoryId: { in: repositories.map(({ id }) => id) } },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        branch: true,
        highlightColor: true,
        codebase: { select: { repositoryId: true } },
      },
    });
    const originByRepositoryId = new Map(
      repositories.map(({ id, canonicalOrigin }) => [id, canonicalOrigin]),
    );
    for (const worktree of worktrees) {
      const origin = originByRepositoryId.get(worktree.codebase.repositoryId);
      if (!origin || !worktree.branch) continue;
      const key = worktreeHighlightKey(origin, worktree.branch);
      // Descending `updatedAt` means the first worktree seen for a branch is
      // the freshest, matching which one the detail lookup's `findFirst` picks.
      if (!highlights.has(key)) {
        highlights.set(key, {
          id: worktree.id,
          highlightColor: worktree.highlightColor,
        });
      }
    }
    return highlights;
  }

  async pullRequests(
    scope: GitHubPullRequestScope,
    repositoryId?: string | null,
    options: {
      includePipelineJobs?: boolean;
      state?: GitHubPullRequestStateFilter;
      first?: number;
      after?: string | null;
      requestSource?: GitHubRequestSource;
    } = {},
  ): Promise<GitHubPullRequestPage> {
    const requestSource = options.requestSource ?? "PULL_REQUESTS_PAGE";
    const first = options.first ?? PULL_REQUEST_PAGE_SIZE;
    if (
      !Number.isInteger(first) ||
      first < 1 ||
      first > PULL_REQUEST_PAGE_SIZE
    ) {
      throw new Error(
        `first must be an integer from 1 to ${PULL_REQUEST_PAGE_SIZE}`,
      );
    }
    const token = await this.requireToken();
    const prisma = await getPrismaClient();
    const repositories = await prisma.gitHubRepository.findMany();
    const settings = await prisma.gitHubSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    const defaultJiraKeyRegex =
      settings?.defaultJiraKeyRegex ?? DEFAULT_JIRA_KEY_REGEX;
    const appSettings = await prisma.gitHubAppSettings.findUnique({
      where: { id: GITHUB_APP_SETTINGS_ID },
    });
    const appConfigured =
      Boolean(appSettings) &&
      (await this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey));
    const appCredentials =
      appSettings && appConfigured
        ? await this.appCredentials(appSettings)
        : null;
    const state = options.state ?? "OPEN";
    const searchState = pullRequestSearchState(state);
    const scopedRepositoryId = repositoryId ?? null;
    const cursor = decodePullRequestCursor(
      options.after,
      scope,
      scopedRepositoryId,
      state,
    );
    const regexByGitHubId = new Map(
      repositories.map((repository) => [
        repository.githubId,
        repository.jiraKeyRegex,
      ]),
    );
    const loaders = new Map<
      string,
      (after: string | null) => Promise<RawConnection<RawPullRequest>>
    >();
    const queuedSearches: Array<{
      query: string;
      after: string | null;
      resolve: (connection: RawConnection<RawPullRequest>) => void;
      reject: (error: unknown) => void;
    }> = [];
    let searchFlushScheduled = false;
    const batchedSearchPage = (query: string, after: string | null) =>
      new Promise<RawConnection<RawPullRequest>>((resolve, reject) => {
        queuedSearches.push({ query, after, resolve, reject });
        if (searchFlushScheduled) return;
        searchFlushScheduled = true;
        queueMicrotask(async () => {
          searchFlushScheduled = false;
          const batch = queuedSearches.splice(0);
          try {
            const pages = await this.searchPullRequestPages(
              batch.map(({ query: itemQuery, after: itemAfter }) => ({
                query: itemQuery,
                after: itemAfter,
              })),
              token,
              requestSource,
            );
            batch.forEach((item, index) => item.resolve(pages[index]!));
          } catch (error) {
            batch.forEach((item) => item.reject(error));
          }
        });
      });

    if (scope === "REPOSITORY") {
      if (!repositoryId) {
        throw new Error(
          "repositoryId is required for repository pull requests",
        );
      }
      const repository = repositories.find((item) => item.id === repositoryId);
      if (!repository) throw new Error("Managed repository was not found");
      loaders.set("repository", (after) =>
        this.repositoryPullRequestPage(
          repositoryView(repository),
          token,
          state,
          after,
          requestSource,
        ),
      );
    } else {
      if (repositoryId) {
        throw new Error(
          "repositoryId is only valid for repository pull requests",
        );
      }
      if (scope === "REVIEW_REQUESTED") {
        const query = pullRequestSearchQuery(
          "is:pr",
          searchState,
          "review-requested:@me",
          "sort:updated-desc",
        );
        loaders.set("review", (after) =>
          this.searchPullRequestPage(query, token, after, requestSource),
        );
      } else if (scope === "MINE") {
        const authoredQuery = pullRequestSearchQuery(
          "is:pr",
          searchState,
          "author:@me",
          "sort:updated-desc",
        );
        const assignedQuery = pullRequestSearchQuery(
          "is:pr",
          searchState,
          "assignee:@me",
          "-author:@me",
          "sort:updated-desc",
        );
        loaders.set("authored", (after) =>
          batchedSearchPage(authoredQuery, after),
        );
        loaders.set("assigned", (after) =>
          batchedSearchPage(assignedQuery, after),
        );
      } else {
        throw new Error("Unknown GitHub pull request scope");
      }
    }

    type RuntimePullRequestStream = {
      cursor: PullRequestCursorStream;
      loader: (after: string | null) => Promise<RawConnection<RawPullRequest>>;
      searchLimited: boolean;
      items: RawPullRequest[] | null;
      pageInfo: PageInfo | null;
      current: RawPullRequest | null;
    };
    const streams: RuntimePullRequestStream[] = Object.entries(
      cursor.streams,
    ).map(([key, stream]) => {
      const loader = loaders.get(key);
      if (!loader) {
        throw new Error("GitHub pull request pagination cursor is invalid");
      }
      return {
        cursor: stream,
        loader,
        searchLimited: scope !== "REPOSITORY",
        items: null,
        pageInfo: null,
        current: null,
      };
    });

    const ensureCurrent = async (stream: RuntimePullRequestStream) => {
      while (!stream.cursor.exhausted && !stream.current) {
        if (
          stream.searchLimited &&
          stream.cursor.consumed >= SEARCH_RESULT_LIMIT
        ) {
          stream.cursor.exhausted = true;
          return;
        }
        if (!stream.items || !stream.pageInfo) {
          const connection = await stream.loader(stream.cursor.after);
          stream.items = connectionNodes(connection);
          stream.pageInfo = connection.pageInfo;
        }
        if (stream.cursor.offset < stream.items.length) {
          stream.current = stream.items[stream.cursor.offset] ?? null;
          return;
        }
        if (stream.cursor.offset > stream.items.length) {
          throw new Error("GitHub pull request pagination cursor is invalid");
        }
        if (stream.pageInfo.hasNextPage && stream.pageInfo.endCursor) {
          stream.cursor.after = stream.pageInfo.endCursor;
          stream.cursor.offset = 0;
          stream.items = null;
          stream.pageInfo = null;
        } else {
          stream.cursor.exhausted = true;
        }
      }
    };

    const consumeCurrent = (stream: RuntimePullRequestStream) => {
      stream.current = null;
      stream.cursor.offset += 1;
      stream.cursor.consumed += 1;
      const hasMoreInPage = Boolean(
        stream.items && stream.cursor.offset < stream.items.length,
      );
      const hasMorePages = Boolean(stream.pageInfo?.hasNextPage);
      if (
        stream.searchLimited &&
        stream.cursor.consumed >= SEARCH_RESULT_LIMIT
      ) {
        stream.cursor.limitReached = hasMoreInPage || hasMorePages;
        stream.cursor.exhausted = true;
      } else if (hasMoreInPage) {
        stream.current = stream.items?.[stream.cursor.offset] ?? null;
      } else if (hasMorePages && stream.pageInfo?.endCursor) {
        stream.cursor.after = stream.pageInfo.endCursor;
        stream.cursor.offset = 0;
        stream.items = null;
        stream.pageInfo = null;
      } else {
        stream.cursor.exhausted = true;
      }
    };

    const rawItems: RawPullRequest[] = [];
    const selectedIds = new Set<string>();
    while (rawItems.length < first) {
      await Promise.all(streams.map(ensureCurrent));
      const next = streams
        .filter(
          (
            stream,
          ): stream is RuntimePullRequestStream & {
            current: RawPullRequest;
          } => stream.current !== null,
        )
        .sort((left, right) =>
          comparePullRequests(left.current, right.current),
        )[0];
      if (!next) break;
      if (!selectedIds.has(next.current.id)) {
        selectedIds.add(next.current.id);
        rawItems.push(next.current);
      }
      consumeCurrent(next);
    }

    const hasNextPage = streams.some((stream) => !stream.cursor.exhausted);
    const truncated = streams.some((stream) => stream.cursor.limitReached);
    const endCursor = hasNextPage ? encodePullRequestCursor(cursor) : null;

    const highlights = await this.worktreeHighlights(
      rawItems.map((pullRequest) => ({
        nameWithOwner: headRepositoryName(pullRequest),
        branch: pullRequest.headRefName,
      })),
    );
    const items = await Promise.all(
      rawItems.map(async (pullRequest) => {
        const summary = await this.normalizePullRequest(
          pullRequest,
          regexByGitHubId.get(pullRequest.repository.id) ?? defaultJiraKeyRegex,
          token,
          appConfigured,
          requestSource,
        );
        const highlight = pullRequestWorktreeHighlight(pullRequest, highlights);
        return {
          ...summary,
          worktreeId: highlight?.id ?? null,
          worktreeHighlightColor: highlight?.highlightColor ?? null,
        };
      }),
    );
    if (!options.includePipelineJobs) {
      return { items, truncated, hasNextPage, endCursor };
    }

    return {
      items: await Promise.all(
        items.map(async (pullRequest) => {
          const { owner, name } = normalizeGitHubRepositoryName(
            pullRequest.repositoryNameWithOwner,
          );
          return {
            ...pullRequest,
            pipelines: await Promise.all(
              pullRequest.pipelines.map(async (pipeline) => {
                if (!pipeline.workflowRunId) return pipeline;
                const jobs = await this.workflowJobs(
                  owner,
                  name,
                  pipeline.workflowRunId,
                  token,
                  appCredentials,
                  requestSource,
                );
                const canonical = await this.pipelineStatus.observeJobs(
                  pullRequest.repositoryGithubId,
                  pipeline.workflowRunId,
                  jobs,
                  "REST",
                );
                return canonical ?? { ...pipeline, jobs };
              }),
            ),
          };
        }),
      ),
      truncated,
      hasNextPage,
      endCursor,
    };
  }

  async reviewThreads(): Promise<GitHubReviewThreadPage> {
    const token = await this.requireToken();
    const prisma = await getPrismaClient();
    const repositories = await prisma.gitHubRepository.findMany();
    const discovery = await this.searchReviewPullRequestScopes(
      [
        "is:pr is:open author:@me sort:updated-desc",
        "is:pr is:open assignee:@me sort:updated-desc",
        "is:pr is:open review-requested:@me sort:updated-desc",
        ...repositories.map(
          (repository) =>
            `is:pr is:open repo:${repository.nameWithOwner} sort:updated-desc`,
        ),
      ],
      token,
    );
    const searches = discovery.searches;
    const unique = new Map<string, RawReviewPullRequestMetadata>();
    for (const search of searches) {
      for (const pullRequest of search.items) {
        unique.set(pullRequest.id, pullRequest);
      }
    }
    const pullRequests = await this.hydrateReviewPullRequests(
      [...unique.values()].sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      ),
      token,
    );
    const highlights = await this.worktreeHighlights(
      pullRequests.map((pullRequest) => ({
        nameWithOwner: headRepositoryName(pullRequest),
        branch: pullRequest.headRefName,
      })),
    );
    const threads = (
      await Promise.all(
        pullRequests.map((pullRequest) =>
          this.completeReviewThreads(
            pullRequest.id,
            pullRequest.reviewThreads,
            token,
            "COMMENTS_PAGE",
            highlights,
          ),
        ),
      )
    ).flat();
    threads.sort(
      (left, right) =>
        Date.parse(right.rootComment.createdAt) -
        Date.parse(left.rootComment.createdAt),
    );
    return {
      viewerLogin: discovery.viewerLogin,
      pullRequests: pullRequests.map((pullRequest) =>
        reviewThreadPullRequest(pullRequest, highlights),
      ),
      threads,
      truncated: searches.some((search) => search.truncated),
    };
  }

  async pullRequestForBranch(
    canonicalOrigin: string,
    branch: string,
  ): Promise<GitHubPullRequestView | null> {
    return (
      (await this.pullRequestsForBranches(canonicalOrigin, [branch])).get(
        branch,
      ) ?? null
    );
  }

  async pullRequestsForBranches(
    canonicalOrigin: string,
    branchValues: string[],
    options: GitHubQueryOptions = {},
  ): Promise<Map<string, GitHubPullRequestView | null>> {
    const branches = [
      ...new Set(branchValues.map((branch) => branch.trim()).filter(Boolean)),
    ];
    const result = new Map<string, GitHubPullRequestView | null>(
      branches.map((branch) => [branch, null]),
    );
    if (!branches.length) return result;
    const match = canonicalOrigin.match(/^github\.com\/([^/]+)\/([^/]+)$/i);
    if (!match?.[1] || !match[2]) return result;
    const token = await this.requireToken();
    const owner = match[1];
    const name = match[2];
    const requestSource = options.requestSource ?? "WORKTREES";
    const [appSettings, settings] = await Promise.all([
      (await getPrismaClient()).gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
      }),
      (await getPrismaClient()).gitHubSettings.findUnique({
        where: { id: SETTINGS_ID },
      }),
    ]);
    const appConfigured =
      Boolean(appSettings) &&
      (await this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey));
    for (
      let offset = 0;
      offset < branches.length;
      offset += PULL_REQUEST_PAGE_SIZE
    ) {
      const chunk = branches.slice(offset, offset + PULL_REQUEST_PAGE_SIZE);
      const definitions = chunk
        .map((_, index) => `$branch${index}: String!`)
        .join(", ");
      const selections = chunk
        .map(
          (_, index) => `branch${index}: ref(qualifiedName: $branch${index}) {
            associatedPullRequests(
              states: [OPEN]
              first: 1
              orderBy: { field: UPDATED_AT, direction: DESC }
            ) { nodes { ...PullRequestTableFields } }
          }`,
        )
        .join("\n");
      const variables = Object.fromEntries(
        chunk.map((branch, index) => [
          `branch${index}`,
          `refs/heads/${branch}`,
        ]),
      );
      const data = await this.request<{
        repository: Record<
          string,
          { associatedPullRequests: RawConnection<RawPullRequest> } | null
        > | null;
      }>(
        `query GitHubWorktreePullRequests(
          $owner: String!
          $name: String!
          ${definitions}
        ) {
          repository(owner: $owner, name: $name) { ${selections} }
        }
        ${PULL_REQUEST_FRAGMENT}`,
        { owner, name, ...variables },
        token,
        { requestSource, ...options },
      );
      if (!data.repository) {
        throw new Error(
          "Managed repository was not found or is not accessible",
        );
      }
      await Promise.all(
        chunk.map(async (branch, index) => {
          const raw = connectionNodes(
            data.repository?.[`branch${index}`]?.associatedPullRequests ?? {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          )[0];
          if (!raw) return;
          result.set(
            branch,
            await this.normalizePullRequest(
              raw,
              settings?.defaultJiraKeyRegex ?? DEFAULT_JIRA_KEY_REGEX,
              token,
              appConfigured,
              requestSource,
              options,
            ),
          );
        }),
      );
    }
    return result;
  }

  async pullRequestLiveStatuses(
    idValues: string[],
    options: GitHubQueryOptions = {},
  ): Promise<Map<string, GitHubPullRequestLiveStatus | null>> {
    const ids = [...new Set(idValues.map((id) => id.trim()).filter(Boolean))];
    const result = new Map<string, GitHubPullRequestLiveStatus | null>(
      ids.map((id) => [id, null]),
    );
    if (!ids.length) return result;
    const token = await this.requireToken();
    const requestSource = options.requestSource ?? "WORKTREES";
    const appSettings = await (
      await getPrismaClient()
    ).gitHubAppSettings.findUnique({ where: { id: GITHUB_APP_SETTINGS_ID } });
    const appConfigured =
      Boolean(appSettings) &&
      (await this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey));
    for (
      let offset = 0;
      offset < ids.length;
      offset += PULL_REQUEST_PAGE_SIZE
    ) {
      const chunk = ids.slice(offset, offset + PULL_REQUEST_PAGE_SIZE);
      const data = await this.request<{
        nodes: Array<RawPullRequestLiveStatus | null>;
      }>(
        `query GitHubWorktreePullRequestStatuses($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on PullRequest { ...PullRequestLiveFields }
          }
        }
        ${PULL_REQUEST_LIVE_FRAGMENT}`,
        { ids: chunk },
        token,
        { requestSource, ...options },
      );
      await Promise.all(
        chunk.map(async (id, index) => {
          const raw = data.nodes[index];
          if (!raw) return;
          result.set(
            id,
            await this.normalizePullRequestLiveStatus(
              raw,
              token,
              appConfigured,
              requestSource,
              options,
            ),
          );
        }),
      );
    }
    return result;
  }

  async pullRequest(
    ownerValue: string,
    nameValue: string,
    number: number,
    requestSource: GitHubRequestSource = "PULL_REQUEST_DETAILS",
  ): Promise<GitHubPullRequestDetail | null> {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${ownerValue}/${nameValue}`,
    );
    if (!Number.isInteger(number) || number < 1) {
      throw new Error("Pull request number must be a positive integer");
    }
    const token = await this.requireToken();
    const data = await this.request<{
      repository: { pullRequest: RawPullRequestDetail | null } | null;
    }>(
      `query GitHubPullRequestDetail(
        $owner: String!
        $name: String!
        $number: Int!
      ) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            ...PullRequestDetailFields
            body
            bodyHTML
            author { login avatarUrl url }
            assignees(first: 100) {
              nodes { login avatarUrl url }
              pageInfo { hasNextPage endCursor }
            }
            baseRefName
            headRefName
            state
            isDraft
            mergeable
            additions
            deletions
            changedFiles
            commits { totalCount }
            mergedAt
          }
        }
      }
      ${PULL_REQUEST_DETAIL_FRAGMENT}`,
      { owner, name, number },
      token,
      { requestSource },
    );
    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) return null;
    const prisma = await getPrismaClient();
    const [managedRepositories, appSettings, settings] = await Promise.all([
      prisma.gitHubRepository.findMany(),
      prisma.gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
      }),
      prisma.gitHubSettings.findUnique({ where: { id: SETTINGS_ID } }),
    ]);
    const managedRepository = managedRepositories.find(
      (repository) => repository.githubId === pullRequest.repository.id,
    );
    const appConfigured =
      Boolean(appSettings) &&
      (await this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey));
    const summary = await this.normalizePullRequest(
      pullRequest,
      managedRepository?.jiraKeyRegex ??
        settings?.defaultJiraKeyRegex ??
        DEFAULT_JIRA_KEY_REGEX,
      token,
      appConfigured,
      requestSource,
    );
    const pipelines = await Promise.all(
      summary.pipelines.map(async (pipeline) => {
        const workflowRunId = pipeline.workflowRunId;
        if (!workflowRunId) return pipeline;
        let run: RawActionsWorkflowRun | null = null;
        try {
          run = await this.restRequest<RawActionsWorkflowRun>(
            `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
              name,
            )}/actions/runs/${encodeURIComponent(workflowRunId)}`,
            GITHUB_REST_OPERATIONS.actions.getWorkflowRun,
            token,
            requestSource,
          );
        } catch {
          // Attempt metadata is additive; preserve the existing PR pipeline when
          // GitHub does not expose the REST run to this token.
        }
        const jobs = await this.workflowJobs(
          owner,
          name,
          workflowRunId,
          token,
          appSettings && appConfigured
            ? await this.appCredentials(appSettings)
            : null,
          requestSource,
        );
        const enriched = {
          ...pipeline,
          workflowId: run
            ? String(run.workflow_id ?? pipeline.name)
            : pipeline.workflowId,
          runNumber: run?.run_number ?? pipeline.runNumber,
          runAttempt: run ? (run.run_attempt ?? 1) : pipeline.runAttempt,
          status: run
            ? pipelineState(run.status, run.conclusion)
            : pipeline.status,
          jobs,
        };
        if (run) {
          await this.pipelineStatus.observeSnapshot({
            repositoryGithubId: summary.repositoryGithubId,
            repositoryNameWithOwner: summary.repositoryNameWithOwner,
            repositoryUrl: summary.repositoryUrl,
            headSha: summary.headRefOid,
            pipelines: [
              {
                ...enriched,
                source: "REST",
                githubUpdatedAt: new Date(run.updated_at),
              },
            ],
          });
        }
        return (
          (await this.pipelineStatus.observeJobs(
            summary.repositoryGithubId,
            workflowRunId,
            jobs,
            "REST",
            run ? new Date(run.updated_at) : null,
          )) ?? enriched
        );
      }),
    );
    const normalizedReviewThreads = await this.completeReviewThreads(
      pullRequest.id,
      pullRequest.reviewThreads,
      token,
      requestSource,
    );
    const baseCanonicalOrigin = `github.com/${pullRequest.repository.nameWithOwner.toLowerCase()}`;
    const codebaseRepository = await prisma.codebaseRepository.findFirst({
      where: { canonicalOrigin: baseCanonicalOrigin },
      select: { id: true },
    });
    const canonicalOrigin = pullRequest.headRepository
      ? `github.com/${pullRequest.headRepository.nameWithOwner.toLowerCase()}`
      : null;
    const matchingRepository =
      canonicalOrigin === baseCanonicalOrigin
        ? codebaseRepository
        : canonicalOrigin
          ? await prisma.codebaseRepository.findFirst({
              where: { canonicalOrigin },
              select: { id: true },
            })
          : null;
    const worktree = matchingRepository
      ? await prisma.worktree.findFirst({
          where: {
            branch: pullRequest.headRefName,
            missingAt: null,
            codebase: { repositoryId: matchingRepository.id },
          },
          orderBy: { updatedAt: "desc" },
          select: { id: true, highlightColor: true },
        })
      : null;
    const reviewThreads = normalizedReviewThreads.map((thread) => ({
      ...thread,
      pullRequest: {
        ...thread.pullRequest,
        worktreeId: worktree?.id ?? null,
        worktreeHighlightColor: worktree?.highlightColor ?? null,
      },
    }));
    return {
      ...summary,
      codebaseRepositoryId: codebaseRepository?.id ?? null,
      pipelines,
      body: pullRequest.body,
      bodyHtml: pullRequest.bodyHTML,
      author: pullRequest.author,
      assignees: connectionNodes(pullRequest.assignees),
      reviewThreads,
      baseRefName: pullRequest.baseRefName,
      headRefName: pullRequest.headRefName,
      state: pullRequest.state,
      isDraft: pullRequest.isDraft,
      mergeable: pullRequest.mergeable,
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changedFiles,
      commitCount: pullRequest.commits.totalCount,
      updatedAt: pullRequest.updatedAt,
      mergedAt: pullRequest.mergedAt,
      worktreeId: worktree?.id ?? null,
      worktreeHighlightColor: worktree?.highlightColor ?? null,
    };
  }

  private mergeBlockedReason(
    pullRequest: RawPullRequestMergeState,
    viewerPermission: RepositoryPermission | null,
  ): string | null {
    if (pullRequest.state !== "OPEN") return "The pull request is not open.";
    if (pullRequest.isDraft) return "Draft pull requests cannot be merged.";
    if (
      !viewerPermission ||
      !["ADMIN", "MAINTAIN", "WRITE"].includes(viewerPermission)
    ) {
      return "You do not have permission to merge pull requests in this repository.";
    }
    if (pullRequest.mergeable === "CONFLICTING")
      return "The pull request has merge conflicts.";
    if (pullRequest.mergeable === "UNKNOWN")
      return "GitHub is still calculating mergeability. Try again shortly.";
    if (pullRequest.mergeStateStatus === "BEHIND")
      return "The branch must be updated with the base branch before it can be merged.";
    if (pullRequest.mergeStateStatus === "BLOCKED")
      return "Required reviews, checks, or branch protection rules have not been satisfied.";
    if (pullRequest.mergeStateStatus === "DIRTY")
      return "The pull request has merge conflicts.";
    if (pullRequest.mergeStateStatus === "DRAFT")
      return "Draft pull requests cannot be merged.";
    if (pullRequest.mergeStateStatus === "UNKNOWN")
      return "GitHub is still calculating the merge requirements. Try again shortly.";
    return null;
  }

  private async mergeState(
    owner: string,
    name: string,
    number: number,
    token: string,
    requestSource: GitHubRequestSource,
  ): Promise<{
    pullRequest: RawPullRequestMergeState;
    availableMethods: GitHubMergeMethod[];
    viewerEmail: string | null;
    viewerPermission: RepositoryPermission | null;
  }> {
    const data = await this.request<{
      viewer: { email: string };
      repository: {
        mergeCommitAllowed: boolean;
        rebaseMergeAllowed: boolean;
        squashMergeAllowed: boolean;
        viewerPermission: RepositoryPermission | null;
        pullRequest: RawPullRequestMergeState | null;
      } | null;
    }>(
      `query GitHubPullRequestMergeOptions(
        $owner: String!
        $name: String!
        $number: Int!
      ) {
        viewer { email }
        repository(owner: $owner, name: $name) {
          mergeCommitAllowed
          rebaseMergeAllowed
          squashMergeAllowed
          viewerPermission
          pullRequest(number: $number) {
            id title body url state isDraft mergeable mergeStateStatus
            headRefOid headRefName headRepository { nameWithOwner } mergedAt
            autoMergeRequest { enabledAt }
            viewerCanEnableAutoMerge
            viewerCanDisableAutoMerge
          }
        }
      }`,
      { owner, name, number },
      token,
      { requestSource },
    );
    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) throw new Error("Pull request was not found");
    const availableMethods: GitHubMergeMethod[] = [];
    if (data.repository?.squashMergeAllowed) availableMethods.push("SQUASH");
    if (data.repository?.mergeCommitAllowed) availableMethods.push("MERGE");
    if (data.repository?.rebaseMergeAllowed) availableMethods.push("REBASE");
    return {
      pullRequest,
      availableMethods,
      viewerEmail: data.viewer.email.trim() || null,
      viewerPermission: data.repository?.viewerPermission ?? null,
    };
  }

  private async commitEmailOptions(
    token: string,
    viewerEmail: string | null,
    requestSource: GitHubRequestSource,
  ): Promise<{ emails: string[]; primaryEmail: string | null }> {
    const emails = new Set<string>();
    let primaryEmail: string | null = null;
    if (viewerEmail) emails.add(viewerEmail);
    try {
      const values = await this.restRequest<
        Array<{ email: string; verified: boolean; primary: boolean }>
      >(
        `${GITHUB_API_BASE_URL}/user/emails?per_page=100`,
        GITHUB_REST_OPERATIONS.users.listEmailsForAuthenticatedUser,
        token,
        requestSource,
      );
      for (const value of values) {
        const email = value.email.trim();
        if (!value.verified || !email) continue;
        emails.add(email);
        if (value.primary) primaryEmail = email;
      }
    } catch {
      // The token may not include user:email. The public viewer email and
      // GitHub's account-default option remain available in that case.
    }
    return {
      emails: [...emails].sort((left, right) => left.localeCompare(right)),
      primaryEmail,
    };
  }

  async pullRequestMergeOptions(
    ownerValue: string,
    nameValue: string,
    number: number,
    requestSource: GitHubRequestSource = "PULL_REQUEST_DETAILS",
  ): Promise<GitHubPullRequestMergeOptions> {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${ownerValue}/${nameValue}`,
    );
    if (!Number.isInteger(number) || number < 1) {
      throw new Error("Pull request number must be a positive integer");
    }
    const token = await this.requireToken();
    const state = await this.mergeState(
      owner,
      name,
      number,
      token,
      requestSource,
    );
    const commitEmailOptions = await this.commitEmailOptions(
      token,
      state.viewerEmail,
      requestSource,
    );
    const blockedReason =
      this.mergeBlockedReason(state.pullRequest, state.viewerPermission) ??
      (state.availableMethods.length === 0
        ? "This repository does not have an available merge method."
        : null);
    return {
      availableMethods: state.availableMethods,
      commitEmails: commitEmailOptions.emails,
      defaultCommitEmail: commitEmailOptions.primaryEmail,
      defaultCommitHeadline: state.pullRequest.title,
      defaultCommitBody: state.pullRequest.body,
      canMerge: blockedReason === null,
      canEnableAutoMerge:
        state.pullRequest.state === "OPEN" &&
        !state.pullRequest.isDraft &&
        !state.pullRequest.autoMergeRequest &&
        Boolean(state.pullRequest.viewerCanEnableAutoMerge) &&
        state.availableMethods.length > 0,
      autoMergeEnabled: Boolean(state.pullRequest.autoMergeRequest),
      viewerCanDisableAutoMerge: Boolean(
        state.pullRequest.viewerCanDisableAutoMerge,
      ),
      mergeStateStatus: state.pullRequest.mergeStateStatus,
      headRefOid: state.pullRequest.headRefOid,
      blockedReason,
    };
  }

  async pullRequestAutomationState(
    ownerValue: string,
    nameValue: string,
    number: number,
  ) {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${ownerValue}/${nameValue}`,
    );
    const token = await this.requireToken();
    const { pullRequest } = await this.mergeState(
      owner,
      name,
      number,
      token,
      "WORKTREE_AUTOMATION",
    );
    return this.automationStateView(pullRequest);
  }

  private automationStateView(pullRequest: RawPullRequestMergeState) {
    return {
      id: pullRequest.id,
      state: pullRequest.mergedAt ? ("MERGED" as const) : pullRequest.state,
      url: pullRequest.url,
      mergedAt: pullRequest.mergedAt,
      headRefOid: pullRequest.headRefOid,
      headRefName: pullRequest.headRefName,
      headRepositoryNameWithOwner:
        pullRequest.headRepository?.nameWithOwner ?? null,
      mergeable: pullRequest.mergeable,
      mergeStateStatus: pullRequest.mergeStateStatus,
      autoMergeEnabled: Boolean(pullRequest.autoMergeRequest),
      viewerCanEnableAutoMerge: Boolean(pullRequest.viewerCanEnableAutoMerge),
      viewerCanDisableAutoMerge: Boolean(pullRequest.viewerCanDisableAutoMerge),
    };
  }

  async enablePullRequestAutoMerge(
    input: {
      owner: string;
      name: string;
      number: number;
      method: GitHubMergeMethod;
      commitHeadline: string;
      commitBody: string;
      authorEmail?: string | null;
    },
    requestSource: GitHubRequestSource = "PULL_REQUEST_DETAILS",
  ) {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${input.owner}/${input.name}`,
    );
    const token = await this.requireToken();
    const state = await this.mergeState(
      owner,
      name,
      input.number,
      token,
      requestSource,
    );
    if (state.pullRequest.state !== "OPEN" || state.pullRequest.isDraft) {
      throw new Error(
        "Only an open, non-draft pull request can use Auto Merge",
      );
    }
    if (!state.availableMethods.includes(input.method)) {
      throw new Error(
        "The selected merge method is not enabled for this repository.",
      );
    }
    if (
      !state.pullRequest.autoMergeRequest &&
      !state.pullRequest.viewerCanEnableAutoMerge
    ) {
      throw new Error(
        "GitHub does not allow Auto Merge for this pull request. It may already be ready to merge.",
      );
    }
    if (state.pullRequest.autoMergeRequest) {
      if (!state.pullRequest.viewerCanDisableAutoMerge) {
        throw new Error("You cannot update this Auto Merge request");
      }
      await this.request(
        `mutation ReplaceGitHubPullRequestAutoMerge($pullRequestId: ID!) {
          disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
            pullRequest { id }
          }
        }`,
        { pullRequestId: state.pullRequest.id },
        token,
        { requestSource },
      );
    }
    const commitHeadline = input.commitHeadline.trim();
    if (!commitHeadline) throw new Error("A commit message is required");
    const data = await this.request<{
      enablePullRequestAutoMerge: {
        pullRequest: RawPullRequestMergeState | null;
      };
    }>(
      `mutation EnableGitHubPullRequestAutoMerge(
        $pullRequestId: ID!
        $method: PullRequestMergeMethod!
        $commitHeadline: String!
        $commitBody: String!
        $authorEmail: String
      ) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId
          mergeMethod: $method
          commitHeadline: $commitHeadline
          commitBody: $commitBody
          authorEmail: $authorEmail
        }) {
          pullRequest {
            id title body url state isDraft mergeable mergeStateStatus
            headRefOid headRefName headRepository { nameWithOwner } mergedAt
            autoMergeRequest { enabledAt }
            viewerCanEnableAutoMerge
            viewerCanDisableAutoMerge
          }
        }
      }`,
      {
        pullRequestId: state.pullRequest.id,
        method: input.method,
        commitHeadline,
        commitBody: input.commitBody,
        authorEmail: input.authorEmail?.trim() || null,
      },
      token,
      { requestSource },
    );
    if (!data.enablePullRequestAutoMerge.pullRequest) {
      throw new Error("GitHub did not return the updated pull request");
    }
    return this.automationStateView(
      data.enablePullRequestAutoMerge.pullRequest,
    );
  }

  async disablePullRequestAutoMerge(
    input: {
      owner: string;
      name: string;
      number: number;
    },
    requestSource: GitHubRequestSource = "PULL_REQUEST_DETAILS",
  ) {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${input.owner}/${input.name}`,
    );
    const token = await this.requireToken();
    const state = await this.mergeState(
      owner,
      name,
      input.number,
      token,
      requestSource,
    );
    if (!state.pullRequest.autoMergeRequest) {
      return this.automationStateView(state.pullRequest);
    }
    if (!state.pullRequest.viewerCanDisableAutoMerge) {
      throw new Error("You cannot disable this Auto Merge request");
    }
    const data = await this.request<{
      disablePullRequestAutoMerge: {
        pullRequest: RawPullRequestMergeState | null;
      };
    }>(
      `mutation DisableGitHubPullRequestAutoMerge($pullRequestId: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            id title body url state isDraft mergeable mergeStateStatus
            headRefOid headRefName headRepository { nameWithOwner } mergedAt
            autoMergeRequest { enabledAt }
            viewerCanEnableAutoMerge
            viewerCanDisableAutoMerge
          }
        }
      }`,
      { pullRequestId: state.pullRequest.id },
      token,
      { requestSource },
    );
    if (!data.disablePullRequestAutoMerge.pullRequest) {
      throw new Error("GitHub did not return the updated pull request");
    }
    return this.automationStateView(
      data.disablePullRequestAutoMerge.pullRequest,
    );
  }

  async mergePullRequest(
    input: {
      owner: string;
      name: string;
      number: number;
      method: GitHubMergeMethod;
      commitHeadline: string;
      commitBody: string;
      authorEmail?: string | null;
    },
    requestSource: GitHubRequestSource = "PULL_REQUEST_DETAILS",
  ): Promise<GitHubPullRequestMergeResult> {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${input.owner}/${input.name}`,
    );
    if (!Number.isInteger(input.number) || input.number < 1) {
      throw new Error("Pull request number must be a positive integer");
    }
    const commitHeadline = input.commitHeadline.trim();
    if (!commitHeadline) throw new Error("A commit message is required");
    const token = await this.requireToken();
    const state = await this.mergeState(
      owner,
      name,
      input.number,
      token,
      requestSource,
    );
    const blockedReason = this.mergeBlockedReason(
      state.pullRequest,
      state.viewerPermission,
    );
    if (blockedReason) throw new Error(blockedReason);
    if (!state.availableMethods.includes(input.method)) {
      throw new Error(
        "The selected merge method is not enabled for this repository.",
      );
    }
    const authorEmail = input.authorEmail?.trim() || null;
    if (authorEmail) {
      const availableEmails = await this.commitEmailOptions(
        token,
        state.viewerEmail,
        requestSource,
      );
      if (!availableEmails.emails.includes(authorEmail)) {
        throw new Error(
          "The selected commit email is not available for this GitHub account.",
        );
      }
    }
    const data = await this.request<{
      mergePullRequest: {
        pullRequest: {
          id: string;
          state: "OPEN" | "CLOSED" | "MERGED";
          url: string;
          mergedAt: string | null;
        } | null;
      };
    }>(
      `mutation MergeGitHubPullRequest(
        $pullRequestId: ID!
        $method: PullRequestMergeMethod!
        $commitHeadline: String!
        $commitBody: String!
        $authorEmail: String
        $expectedHeadOid: GitObjectID!
      ) {
        mergePullRequest(input: {
          pullRequestId: $pullRequestId
          mergeMethod: $method
          commitHeadline: $commitHeadline
          commitBody: $commitBody
          authorEmail: $authorEmail
          expectedHeadOid: $expectedHeadOid
        }) {
          pullRequest { id state url mergedAt }
        }
      }`,
      {
        pullRequestId: state.pullRequest.id,
        method: input.method,
        commitHeadline,
        commitBody: input.commitBody,
        authorEmail,
        expectedHeadOid: state.pullRequest.headRefOid,
      },
      token,
      { requestSource },
    );
    const pullRequest = data.mergePullRequest.pullRequest;
    if (!pullRequest)
      throw new Error("GitHub did not return the merged pull request");
    return pullRequest;
  }

  async createPullRequest(input: {
    owner: string;
    name: string;
    baseRefName: string;
    headRefName: string;
    title: string;
    body?: string | null;
    draft?: boolean | null;
  }): Promise<GitHubPullRequestDetail> {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${input.owner}/${input.name}`,
    );
    const baseRefName = input.baseRefName.trim();
    const headRefName = input.headRefName.trim();
    const title = input.title.trim();
    if (!baseRefName || !headRefName || !title) {
      throw new Error("Base branch, head branch, and title are required");
    }
    const credentials = await this.requireAppCredentials();
    const repository = await this.appRequest<{
      repository: {
        id: string;
        base: { id: string } | null;
        head: { id: string } | null;
      } | null;
    }>(
      credentials,
      `query WorkflowCreatePullRequestRepository(
        $owner: String!
        $name: String!
        $base: String!
        $head: String!
      ) {
        repository(owner: $owner, name: $name) {
          id
          base: ref(qualifiedName: $base) { id }
          head: ref(qualifiedName: $head) { id }
        }
      }`,
      {
        owner,
        name,
        base: `refs/heads/${baseRefName}`,
        head: `refs/heads/${headRefName}`,
      },
      { requestSource: "WORKFLOW_AUTOMATION" },
    );
    if (!repository.data.repository)
      throw new Error("GitHub repository was not found");
    if (!repository.data.repository.base)
      throw new Error("Pull request base branch was not found on GitHub");
    if (!repository.data.repository.head) {
      throw new Error("Push the workflow branch before opening a pull request");
    }
    const created = await this.appRequest<{
      createPullRequest: {
        pullRequest: { number: number } | null;
      };
    }>(
      credentials,
      `mutation WorkflowCreatePullRequest(
        $repositoryId: ID!
        $baseRefName: String!
        $headRefName: String!
        $title: String!
        $body: String
        $draft: Boolean
      ) {
        createPullRequest(input: {
          repositoryId: $repositoryId
          baseRefName: $baseRefName
          headRefName: $headRefName
          title: $title
          body: $body
          draft: $draft
        }) { pullRequest { number } }
      }`,
      {
        repositoryId: repository.data.repository.id,
        baseRefName,
        headRefName,
        title,
        body: input.body ?? "",
        draft: Boolean(input.draft),
      },
      { requestSource: "WORKFLOW_AUTOMATION" },
    );
    const number = created.data.createPullRequest.pullRequest?.number;
    if (!number) throw new Error("GitHub did not return the new pull request");
    const detail = await this.pullRequest(
      owner,
      name,
      number,
      "WORKFLOW_AUTOMATION",
    );
    if (!detail) throw new Error("The new pull request could not be loaded");
    return detail;
  }

  async updatePullRequest(input: {
    owner: string;
    name: string;
    number: number;
    title?: string | null;
    body?: string | null;
    draft?: boolean | null;
  }): Promise<GitHubPullRequestDetail> {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${input.owner}/${input.name}`,
    );
    const current = await this.pullRequest(
      owner,
      name,
      input.number,
      "WORKFLOW_AUTOMATION",
    );
    if (!current) throw new Error("Pull request was not found");
    const mutationInput: Record<string, unknown> = {
      pullRequestId: current.id,
    };
    if (input.title !== undefined && input.title !== null) {
      const title = input.title.trim();
      if (!title) throw new Error("Pull request title cannot be empty");
      mutationInput.title = title;
    }
    if (input.body !== undefined && input.body !== null) {
      mutationInput.body = input.body;
    }
    const token = await this.requireToken();
    if (Object.keys(mutationInput).length > 1) {
      await this.request(
        `mutation WorkflowUpdatePullRequest($input: UpdatePullRequestInput!) {
          updatePullRequest(input: $input) { pullRequest { id } }
        }`,
        { input: mutationInput },
        token,
        { requestSource: "WORKFLOW_AUTOMATION" },
      );
    }
    if (input.draft !== undefined && input.draft !== null) {
      if (input.draft && !current.isDraft) {
        await this.request(
          `mutation WorkflowConvertPullRequestToDraft($id: ID!) {
            convertPullRequestToDraft(input: { pullRequestId: $id }) {
              pullRequest { id }
            }
          }`,
          { id: current.id },
          token,
          { requestSource: "WORKFLOW_AUTOMATION" },
        );
      } else if (!input.draft && current.isDraft) {
        await this.request(
          `mutation WorkflowMarkPullRequestReady($id: ID!) {
            markPullRequestReadyForReview(input: { pullRequestId: $id }) {
              pullRequest { id }
            }
          }`,
          { id: current.id },
          token,
          { requestSource: "WORKFLOW_AUTOMATION" },
        );
      }
    }
    await this.cache.clear();
    const detail = await this.pullRequest(
      owner,
      name,
      input.number,
      "WORKFLOW_AUTOMATION",
    );
    if (!detail)
      throw new Error("The updated pull request could not be loaded");
    return detail;
  }

  async submitPullRequestReview(input: {
    owner: string;
    name: string;
    number: number;
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body?: string | null;
  }): Promise<GitHubPullRequestDetail> {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${input.owner}/${input.name}`,
    );
    const pullRequest = await this.pullRequest(
      owner,
      name,
      input.number,
      "WORKFLOW_AUTOMATION",
    );
    if (!pullRequest) throw new Error("Pull request was not found");
    const body = input.body?.trim() ?? "";
    if (input.event === "REQUEST_CHANGES" && !body) {
      throw new Error("A review body is required when requesting changes");
    }
    const token = await this.requireToken();
    await this.request(
      `mutation WorkflowSubmitPullRequestReview(
        $pullRequestId: ID!
        $event: PullRequestReviewEvent!
        $body: String
      ) {
        addPullRequestReview(input: {
          pullRequestId: $pullRequestId
          event: $event
          body: $body
        }) { pullRequestReview { id } }
      }`,
      { pullRequestId: pullRequest.id, event: input.event, body },
      token,
      { requestSource: "WORKFLOW_AUTOMATION" },
    );
    await this.cache.clear();
    const detail = await this.pullRequest(
      owner,
      name,
      input.number,
      "WORKFLOW_AUTOMATION",
    );
    if (!detail)
      throw new Error("The reviewed pull request could not be loaded");
    return detail;
  }

  async requestPullRequestReviewers(input: {
    owner: string;
    name: string;
    number: number;
    reviewers?: string[] | null;
    teamReviewers?: string[] | null;
  }): Promise<GitHubPullRequestDetail> {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${input.owner}/${input.name}`,
    );
    const pullRequest = await this.pullRequest(
      owner,
      name,
      input.number,
      "WORKFLOW_AUTOMATION",
    );
    if (!pullRequest) throw new Error("Pull request was not found");
    const reviewers = [
      ...new Set(
        (input.reviewers ?? []).map((value) => value.trim()).filter(Boolean),
      ),
    ];
    const teamReviewers = [
      ...new Set(
        (input.teamReviewers ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (!reviewers.length && !teamReviewers.length) {
      throw new Error("At least one user or team reviewer is required");
    }
    const token = await this.requireToken();
    const userIds: string[] = [];
    for (const login of reviewers) {
      const data = await this.request<{ user: { id: string } | null }>(
        `query WorkflowReviewer($login: String!) { user(login: $login) { id } }`,
        { login },
        token,
        { requestSource: "WORKFLOW_AUTOMATION" },
      );
      if (!data.user) throw new Error(`GitHub user was not found: ${login}`);
      userIds.push(data.user.id);
    }
    const teamIds: string[] = [];
    for (const slug of teamReviewers) {
      const data = await this.request<{
        organization: { team: { id: string } | null } | null;
      }>(
        `query WorkflowReviewTeam($organization: String!, $slug: String!) {
          organization(login: $organization) { team(slug: $slug) { id } }
        }`,
        { organization: owner, slug },
        token,
        { requestSource: "WORKFLOW_AUTOMATION" },
      );
      const team = data.organization?.team;
      if (!team) throw new Error(`GitHub team was not found: ${slug}`);
      teamIds.push(team.id);
    }
    await this.request(
      `mutation WorkflowRequestPullRequestReviews(
        $pullRequestId: ID!
        $userIds: [ID!]
        $teamIds: [ID!]
      ) {
        requestReviews(input: {
          pullRequestId: $pullRequestId
          userIds: $userIds
          teamIds: $teamIds
        }) { pullRequest { id } }
      }`,
      { pullRequestId: pullRequest.id, userIds, teamIds },
      token,
      { requestSource: "WORKFLOW_AUTOMATION" },
    );
    await this.cache.clear();
    const detail = await this.pullRequest(
      owner,
      name,
      input.number,
      "WORKFLOW_AUTOMATION",
    );
    if (!detail)
      throw new Error("The updated pull request could not be loaded");
    return detail;
  }

  async dispatchWorkflow(input: {
    repositoryId: string;
    workflowId: string;
    ref: string;
    inputs?: Record<string, string> | null;
  }): Promise<boolean> {
    const repositoryId = input.repositoryId.trim();
    const workflowId = input.workflowId.trim();
    const ref = input.ref.trim();
    if (!repositoryId || !workflowId || !ref) {
      throw new Error("Repository, workflow, and Git ref are required");
    }
    const target = await this.actionsTargetByIdentifier(repositoryId);
    const token = await this.requireToken();
    await this.restMutation(
      `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
        target.name,
      )}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      GITHUB_REST_OPERATIONS.actions.dispatchWorkflow,
      token,
      "WORKFLOW_AUTOMATION",
      { ref, inputs: input.inputs ?? {} },
    );
    await this.cache.clear();
    return true;
  }

  async setPullRequestLabels(input: {
    owner: string;
    name: string;
    number: number;
    labels: string[];
  }): Promise<GitHubPullRequestDetail> {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${input.owner}/${input.name}`,
    );
    const labels = [
      ...new Set(input.labels.map((label) => label.trim()).filter(Boolean)),
    ];
    const credentials = await this.requireAppCredentials();
    const loaded = await this.appRequest<{
      repository: {
        pullRequest: {
          id: string;
          labels: { nodes: Array<{ id: string; name: string }> };
        } | null;
        labels: { nodes: Array<{ id: string; name: string }> };
      } | null;
    }>(
      credentials,
      `query WorkflowPullRequestLabels($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) { id labels(first: 100) { nodes { id name } } }
          labels(first: 100) { nodes { id name } }
        }
      }`,
      { owner, name, number: input.number },
      { requestSource: "WORKFLOW_AUTOMATION" },
    );
    const pullRequest = loaded.data.repository?.pullRequest;
    if (!pullRequest) throw new Error("Pull request was not found");
    const available = new Map(
      (loaded.data.repository?.labels.nodes ?? []).map((label) => [
        label.name,
        label.id,
      ]),
    );
    const missing = labels.filter((label) => !available.has(label));
    if (missing.length)
      throw new Error(`GitHub labels do not exist: ${missing.join(", ")}`);
    const current = new Map(
      pullRequest.labels.nodes.map((label) => [label.name, label.id]),
    );
    const add = labels
      .filter((label) => !current.has(label))
      .map((label) => available.get(label)!);
    const remove = [...current]
      .filter(([label]) => !labels.includes(label))
      .map(([, id]) => id);
    if (add.length || remove.length) {
      await this.appRequest(
        credentials,
        `mutation WorkflowSetPullRequestLabels(
          $id: ID!
          $addIds: [ID!]!
          $removeIds: [ID!]!
          $shouldAdd: Boolean!
          $shouldRemove: Boolean!
        ) {
          add: addLabelsToLabelable(
            input: { labelableId: $id, labelIds: $addIds }
          ) @include(if: $shouldAdd) { clientMutationId }
          remove: removeLabelsFromLabelable(
            input: { labelableId: $id, labelIds: $removeIds }
          ) @include(if: $shouldRemove) { clientMutationId }
        }`,
        {
          id: pullRequest.id,
          addIds: add,
          removeIds: remove,
          shouldAdd: add.length > 0,
          shouldRemove: remove.length > 0,
        },
        { requestSource: "WORKFLOW_AUTOMATION" },
      );
    }
    const detail = await this.pullRequest(
      owner,
      name,
      input.number,
      "WORKFLOW_AUTOMATION",
    );
    if (!detail)
      throw new Error("The updated pull request could not be loaded");
    return detail;
  }

  async replyToReviewThread(
    threadId: string,
    body: string,
    requestSource: GitHubRequestSource = "COMMENTS_PAGE",
  ): Promise<GitHubReviewComment> {
    if (!threadId.trim()) throw new Error("Review thread ID is required");
    if (!body.trim()) throw new Error("A reply is required");
    const token = await this.requireToken();
    const data = await this.request<{
      addPullRequestReviewThreadReply: { comment: RawReviewComment | null };
    }>(
      `mutation ReplyToGitHubReviewThread($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(
          input: {
            pullRequestReviewThreadId: $threadId
            body: $body
          }
        ) {
          comment { ${REVIEW_COMMENT_FIELDS} }
        }
      }`,
      { threadId, body },
      token,
      { requestSource },
    );
    const comment = data.addPullRequestReviewThreadReply.comment;
    if (!comment) throw new Error("GitHub did not return the new reply");
    return normalizeReviewComment(comment);
  }

  async setReviewThreadResolved(
    threadId: string,
    resolved: boolean,
    requestSource: GitHubRequestSource = "COMMENTS_PAGE",
  ): Promise<GitHubReviewThreadState> {
    if (!threadId.trim()) throw new Error("Review thread ID is required");
    const token = await this.requireToken();
    const stateFields = `
      id
      isResolved
      viewerCanResolve
      viewerCanUnresolve
      resolvedBy { login avatarUrl url }
    `;
    if (resolved) {
      const data = await this.request<{
        resolveReviewThread: {
          thread: {
            id: string;
            isResolved: boolean;
            viewerCanResolve: boolean;
            viewerCanUnresolve: boolean;
            resolvedBy: RawActor | null;
          } | null;
        };
      }>(
        `mutation ResolveGitHubReviewThread($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { ${stateFields} }
          }
        }`,
        { threadId },
        token,
        { requestSource },
      );
      const thread = data.resolveReviewThread.thread;
      if (!thread) throw new Error("GitHub did not return the resolved thread");
      return normalizeReviewThreadState(thread);
    }
    const data = await this.request<{
      unresolveReviewThread: {
        thread: {
          id: string;
          isResolved: boolean;
          viewerCanResolve: boolean;
          viewerCanUnresolve: boolean;
          resolvedBy: RawActor | null;
        } | null;
      };
    }>(
      `mutation ReopenGitHubReviewThread($threadId: ID!) {
        unresolveReviewThread(input: { threadId: $threadId }) {
          thread { ${stateFields} }
        }
      }`,
      { threadId },
      token,
      { requestSource },
    );
    const thread = data.unresolveReviewThread.thread;
    if (!thread) throw new Error("GitHub did not return the reopened thread");
    return normalizeReviewThreadState(thread);
  }

  async retryPipeline(
    repositoryId: string,
    checkSuiteId: string,
    requestSource: GitHubRequestSource,
    auditContext: GitHubAuditContext,
  ): Promise<GitHubPipelineView> {
    if (!repositoryId.trim() || !checkSuiteId.trim()) {
      throw new Error("Repository and check suite IDs are required");
    }
    try {
      const token = await this.requireToken();
      const data = await this.request<{ node: RawRetryCheckSuite | null }>(
        `query GitHubRetryPipelineCheckSuite($checkSuiteId: ID!) {
          node(id: $checkSuiteId) {
            ... on CheckSuite {
              id
              status
              conclusion
              url
              app { name slug }
              repository { id name owner { login } }
              workflowRun {
                databaseId
                url
                runNumber
                workflow { name }
              }
            }
          }
        }`,
        { checkSuiteId },
        token,
        { requestSource },
      );
      const checkSuite = data.node;
      if (!checkSuite) {
        throw new GitHubAppError(
          "CHECK_SUITE_NOT_FOUND",
          "The GitHub check suite was not found",
        );
      }
      if (checkSuite.repository.id !== repositoryId) {
        throw new GitHubAppError(
          "CHECK_SUITE_REPOSITORY_MISMATCH",
          "The check suite does not belong to the selected repository",
        );
      }
      if (checkSuite.app?.slug !== "github-actions") {
        throw new GitHubAppError(
          "NOT_GITHUB_ACTIONS",
          "Only GitHub Actions workflow runs can be retried",
        );
      }
      if (checkSuite.status !== "COMPLETED") {
        throw new GitHubAppError(
          "WORKFLOW_NOT_COMPLETED",
          "The GitHub Actions workflow must be completed before it can be retried",
        );
      }
      if (!checkSuite.workflowRun?.databaseId) {
        throw new GitHubAppError(
          "WORKFLOW_RUN_UNAVAILABLE",
          "GitHub did not return a workflow run for this check suite",
        );
      }

      const credentials = await this.requireAppCredentials();
      const access = await this.appRequest<{
        repository: { id: string } | null;
      }>(
        credentials,
        `query VerifyGitHubAppRepository($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) { id }
        }`,
        {
          owner: checkSuite.repository.owner.login,
          name: checkSuite.repository.name,
        },
        { requestSource },
      );
      if (access.data.repository?.id !== repositoryId) {
        throw new GitHubAppError(
          "REPOSITORY_NOT_INSTALLED",
          "The repository is not available to the GitHub App installation",
          access.githubRequestId,
        );
      }

      const result = await rerunGitHubActionsWorkflow(credentials, {
        owner: checkSuite.repository.owner.login,
        repository: checkSuite.repository.name,
        workflowRunId: String(checkSuite.workflowRun.databaseId),
        requestSource,
      });
      await this.cache.clear();
      await this.audit(auditContext, {
        operation: "GITHUB_ACTIONS_WORKFLOW_RERUN",
        repositoryId,
        checkSuiteId,
        githubRequestId: result.githubRequestId,
        outcome: "SUCCESS",
      });
      await this.pipelineStatus.optimisticByCheckSuite(
        repositoryId,
        checkSuiteId,
        { status: "QUEUED", jobs: [] },
      );
      return {
        ...checkSuitePipeline(checkSuite, true),
        status: "QUEUED",
        canRetry: false,
        retryUnavailableReason: "NOT_COMPLETED",
      };
    } catch (error) {
      await this.audit(auditContext, {
        operation: "GITHUB_ACTIONS_WORKFLOW_RERUN",
        repositoryId,
        checkSuiteId,
        githubRequestId:
          error instanceof GitHubAppError ? error.githubRequestId : null,
        outcome: "FAILURE",
        errorCode:
          error instanceof GitHubAppError
            ? error.code
            : "GITHUB_APP_REQUEST_FAILED",
      });
      throw error;
    }
  }

  async retryWorkflowJob(
    repositoryId: string,
    checkSuiteId: string,
    jobId: string,
    requestSource: GitHubRequestSource,
    auditContext: GitHubAuditContext,
  ): Promise<boolean> {
    if (!repositoryId.trim() || !checkSuiteId.trim() || !jobId.trim()) {
      throw new Error("Repository, check suite, and job IDs are required");
    }
    try {
      const token = await this.requireToken();
      const data = await this.request<{ node: RawRetryCheckSuite | null }>(
        `query GitHubRetryWorkflowJobCheckSuite($checkSuiteId: ID!) {
          node(id: $checkSuiteId) {
            ... on CheckSuite {
              id
              status
              conclusion
              url
              app { name slug }
              repository { id name owner { login } }
              workflowRun {
                databaseId
                url
                runNumber
                workflow { name }
              }
            }
          }
        }`,
        { checkSuiteId },
        token,
        { requestSource },
      );
      const checkSuite = data.node;
      if (!checkSuite) {
        throw new GitHubAppError(
          "CHECK_SUITE_NOT_FOUND",
          "The GitHub check suite was not found",
        );
      }
      if (checkSuite.repository.id !== repositoryId) {
        throw new GitHubAppError(
          "CHECK_SUITE_REPOSITORY_MISMATCH",
          "The check suite does not belong to the selected repository",
        );
      }
      if (checkSuite.app?.slug !== "github-actions") {
        throw new GitHubAppError(
          "NOT_GITHUB_ACTIONS",
          "Only GitHub Actions workflow jobs can be retried",
        );
      }
      if (checkSuite.status !== "COMPLETED") {
        throw new GitHubAppError(
          "WORKFLOW_NOT_COMPLETED",
          "The GitHub Actions workflow must be completed before a job can be retried",
        );
      }
      if (!checkSuite.workflowRun?.databaseId) {
        throw new GitHubAppError(
          "WORKFLOW_RUN_UNAVAILABLE",
          "GitHub did not return a workflow run for this check suite",
        );
      }

      const credentials = await this.requireAppCredentials();
      const access = await this.appRequest<{
        repository: { id: string } | null;
      }>(
        credentials,
        `query VerifyGitHubAppRepository($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) { id }
        }`,
        {
          owner: checkSuite.repository.owner.login,
          name: checkSuite.repository.name,
        },
        { requestSource },
      );
      if (access.data.repository?.id !== repositoryId) {
        throw new GitHubAppError(
          "REPOSITORY_NOT_INSTALLED",
          "The repository is not available to the GitHub App installation",
          access.githubRequestId,
        );
      }

      const result = await rerunGitHubActionsJob(credentials, {
        owner: checkSuite.repository.owner.login,
        repository: checkSuite.repository.name,
        workflowRunId: String(checkSuite.workflowRun.databaseId),
        jobId,
        requestSource,
      });
      await this.cache.clear();
      await this.audit(auditContext, {
        operation: "GITHUB_ACTIONS_JOB_RERUN",
        repositoryId,
        checkSuiteId,
        jobId,
        githubRequestId: result.githubRequestId,
        outcome: "SUCCESS",
      });
      await this.pipelineStatus.optimisticJobByCheckSuite(
        repositoryId,
        checkSuiteId,
        jobId,
      );
      return true;
    } catch (error) {
      await this.audit(auditContext, {
        operation: "GITHUB_ACTIONS_JOB_RERUN",
        repositoryId,
        checkSuiteId,
        jobId,
        githubRequestId:
          error instanceof GitHubAppError ? error.githubRequestId : null,
        outcome: "FAILURE",
        errorCode:
          error instanceof GitHubAppError
            ? error.code
            : "GITHUB_APP_REQUEST_FAILED",
      });
      throw error;
    }
  }
}
