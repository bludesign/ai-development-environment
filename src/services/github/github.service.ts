import { randomBytes, randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import { CREDENTIALS, CredentialService } from "@/services/credentials";
import {
  cancelGitHubActionsWorkflow,
  clearGitHubAppTokenCache,
  configureGitHubAppWebhook,
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
  GitHubActionsRepositoryErrorView,
  GitHubActionsRepositoryView,
  GitHubActionsWorkflowRunPage,
  GitHubActionsWorkflowRunView,
  GitHubAutoRetryRuleView,
  GitHubAppSettingsView,
  GitHubAuditContext,
  GitHubPipelineState,
  GitHubPipelineStatus,
  GitHubPipelineView,
  GitHubMergeMethod,
  GitHubPullRequestDetail,
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
  GitHubSettingsView,
  GitHubViewer,
  GitHubWorkflowJobView,
  GitHubWorkflowRunAttemptView,
  SaveGitHubAutoRetryRuleInput,
} from "./types";
import { GitHubAutoRetryService } from "./github-auto-retry.service";
import type { PollingService } from "@/services/polling";

const SETTINGS_ID = "default";
const GITHUB_APP_SETTINGS_ID = "default";
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const SEARCH_RESULT_LIMIT = 1000;
const ACTIONS_PAGE_SIZE = 25;
const PULL_REQUEST_PAGE_SIZE = 25;
export const MIN_ACTIONS_NOTIFICATION_POLL_INTERVAL_SECONDS = 30;
export const MAX_ACTIONS_NOTIFICATION_POLL_INTERVAL_SECONDS = 3_600;
export const DEFAULT_JIRA_KEY_REGEX = String.raw`\b([A-Z][A-Z0-9_]*-\d+)\b`;

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
      checkSuite: RawCheckSuite;
    }
  | {
      __typename: "StatusContext";
      id: string;
      context: string;
      state: string;
      description: string | null;
      targetUrl: string | null;
    };

type RawPullRequestDetail = RawPullRequest & {
  body: string;
  bodyHTML: string;
  author: { login: string; avatarUrl: string; url: string } | null;
  assignees: RawConnection<{ login: string; avatarUrl: string; url: string }>;
  reviewThreadsFull: RawConnection<RawReviewThread>;
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

type RawReviewPullRequest = RawReviewThreadPullRequest & {
  updatedAt: string;
  reviewThreads: RawConnection<RawReviewThread>;
};

type GitHubResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

const PIPELINE_CONTEXT_FIELDS = `
  __typename
  ... on CheckRun {
    id
    name
    status
    conclusion
    detailsUrl
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
  }
`;

const PULL_REQUEST_FRAGMENT = `
  fragment PullRequestTableFields on PullRequest {
    id
    number
    title
    url
    createdAt
    updatedAt
    state
    mergedAt
    headRefName
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
    reviewThreads(first: 100) {
      nodes { isResolved }
      pageInfo { hasNextPage endCursor }
    }
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
    repository { nameWithOwner }
  }
  comments(first: 100) {
    nodes { ${REVIEW_COMMENT_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
`;

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
  const value = (conclusion || status || "NONE").toUpperCase();
  if (
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
    value === "TIMED_OUT"
  ) {
    return value;
  }
  if (value === "REQUESTED" || value === "WAITING") return "QUEUED";
  return "NONE";
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
    runAttempt: null,
  };
}

function normalizePipelines(
  contexts: RawPipelineContext[],
  appConfigured: boolean,
): GitHubPipelineView[] {
  const pipelines = new Map<string, GitHubPipelineView>();
  for (const context of contexts) {
    if (context.__typename === "CheckRun") {
      const pipeline = checkSuitePipeline(context.checkSuite, appConfigured);
      pipelines.set(pipeline.id, pipeline);
    } else {
      pipelines.set(context.id, {
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
      });
    }
  }
  return [...pipelines.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
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
): GitHubReviewThreadPullRequest {
  return {
    id: pullRequest.id,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    repositoryNameWithOwner: pullRequest.repository.nameWithOwner,
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
    pullRequest: reviewThreadPullRequest(thread.pullRequest),
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

  constructor(
    startAutoRetry = false,
    private readonly credentials = new CredentialService(),
    private readonly polling?: PollingService,
    private readonly notificationsConfigurationChanged?: () => void,
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
  ): Promise<T> {
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
      throw new Error(
        sanitizeError(
          error instanceof Error ? error.message : String(error),
          token,
        ),
      );
    }

    let body: GitHubResponse<T>;
    try {
      body = (await response.json()) as GitHubResponse<T>;
    } catch {
      throw new Error(`GitHub returned HTTP ${response.status}`);
    }

    if (!response.ok || body.errors?.length || !body.data) {
      const message =
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ") || `GitHub returned HTTP ${response.status}`;
      throw new Error(sanitizeError(message, token));
    }
    return body.data;
  }

  private async restRequest<T>(url: string, token: string): Promise<T> {
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
      throw new Error(
        sanitizeError(
          error instanceof Error ? error.message : String(error),
          token,
        ),
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`GitHub returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : `GitHub returned HTTP ${response.status}`;
      throw new Error(sanitizeError(message, token));
    }
    return body as T;
  }

  private async workflowJobs(
    owner: string,
    repository: string,
    workflowRunId: string,
    token: string,
    appCredentials: GitHubAppCredentials | null,
  ): Promise<GitHubWorkflowJobView[]> {
    const jobs: GitHubActionsWorkflowJob[] = appCredentials
      ? await listGitHubActionsWorkflowJobs(appCredentials, {
          owner,
          repository,
          workflowRunId,
        })
      : await this.patWorkflowJobs(owner, repository, workflowRunId, token);
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
        token,
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
        token,
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
    this.pollingConfigurationChanged();
    return this.getSettings();
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
      accountLogin: string;
      repositorySelection: string;
      actionsPermission: string;
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
    return {
      configured: Boolean(settings && privateKeyConfigured),
      appId: settings?.appId ?? null,
      installationId: settings?.installationId ?? null,
      privateKeyConfigured,
      keyFingerprint: settings?.keyFingerprint ?? null,
      appSlug: settings?.appSlug ?? null,
      accountLogin: settings?.accountLogin ?? null,
      repositorySelection: settings?.repositorySelection ?? null,
      actionsPermission: settings?.actionsPermission ?? null,
      verifiedAt: settings?.verifiedAt.toISOString() ?? null,
      webhookConfigured: Boolean(
        settings?.webhookUrl &&
        settings.webhookConfiguredAt &&
        webhookSecretConfigured,
      ),
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
      settings,
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
    return this.appSettingsView(
      settings,
      privateKeyConfigured,
      webhookSecretConfigured,
      lastDelivery,
    );
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
    };
  }

  async saveAppSettings(
    input: {
      appId: string;
      installationId: string;
      privateKey?: string | null;
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
      clearGitHubAppTokenCache();
      const credentials: GitHubAppCredentials = {
        appId: input.appId,
        installationId: input.installationId,
        privateKey,
        apiBaseUrl: GITHUB_API_BASE_URL,
        graphqlUrl: GITHUB_GRAPHQL_URL,
      };
      const verification = await verifyGitHubAppConfiguration(credentials);
      const webhookUrl = this.webhookUrl(requestOrigin);
      const existingWebhookSecret = await this.credentials.getText(
        CREDENTIALS.githubAppWebhookSecret,
      );
      const webhookSecret = webhookUrl
        ? (existingWebhookSecret ?? randomBytes(32).toString("base64url"))
        : existingWebhookSecret;
      if (webhookUrl && webhookSecret) {
        await configureGitHubAppWebhook(credentials, {
          url: webhookUrl,
          secret: webhookSecret,
        });
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
          accountLogin: verification.accountLogin,
          repositorySelection: verification.repositorySelection,
          actionsPermission: verification.actionsPermission,
          verifiedAt: verification.verifiedAt,
          webhookUrl: webhookUrl ?? existing?.webhookUrl ?? null,
          webhookConfiguredAt: webhookUrl
            ? new Date()
            : (existing?.webhookConfiguredAt ?? null),
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

  private webhookUrl(origin: string | null): string | null {
    if (!origin) return null;
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (
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
        /^fe[89ab][0-9a-f]:/.test(host)
      ) {
        return null;
      }
      return `${url.origin}/api/public/github/webhook`;
    } catch {
      return null;
    }
  }

  async testAppConnection(
    auditContext: GitHubAuditContext,
  ): Promise<GitHubAppSettingsView> {
    try {
      const credentials = await this.requireAppCredentials();
      clearGitHubAppTokenCache();
      const verification = await verifyGitHubAppConfiguration(credentials);
      const prisma = await getPrismaClient();
      await prisma.gitHubAppSettings.update({
        where: { id: GITHUB_APP_SETTINGS_ID },
        data: {
          keyFingerprint: verification.keyFingerprint,
          appSlug: verification.appSlug,
          accountLogin: verification.accountLogin,
          repositorySelection: verification.repositorySelection,
          actionsPermission: verification.actionsPermission,
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
    await this.audit(auditContext, {
      operation: "GITHUB_APP_SETTINGS_CLEAR",
      outcome: "SUCCESS",
    });
    this.notificationsConfigurationChanged?.();
    return this.getAppSettings();
  }

  private async viewer(token: string): Promise<GitHubViewer> {
    const data = await this.request<{ viewer: GitHubViewer }>(
      `query GitHubViewer { viewer { login name avatarUrl url } }`,
      {},
      token,
    );
    return data.viewer;
  }

  async testConnection(): Promise<GitHubViewer> {
    return this.viewer(await this.requireToken());
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
            token,
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
            codebase: { select: { repositoryId: true } },
          },
        })
      : [];
    const worktreeByRepositoryAndBranch = new Map<string, string>();
    for (const worktree of worktrees) {
      if (!worktree.branch) continue;
      const key = `${worktree.codebase.repositoryId}\u0000${worktree.branch}`;
      if (!worktreeByRepositoryAndBranch.has(key)) {
        worktreeByRepositoryAndBranch.set(key, worktree.id);
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
        this.actionsPullRequestNumbers(run, target, token),
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
          worktreeId: run.head_branch
            ? (worktreeByRepositoryAndBranch.get(
                `${target.id}\u0000${run.head_branch}`,
              ) ?? null)
            : null,
          startedAt: run.run_started_at ?? run.created_at,
          createdAt: run.created_at,
          updatedAt: run.updated_at,
        };
      },
    );
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
      items,
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
    );
    return this.workflowJobViews(jobs, appSettings !== null);
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
        token,
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
      token,
    );
    const jobs = includeJobs
      ? await this.patWorkflowAttemptJobs(target, workflowRunId, attempt, token)
      : [];
    const appConfigured =
      Boolean(appSettings) &&
      (await this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey));
    return {
      workflowRunId,
      runAttempt: run.run_attempt ?? attempt,
      status: pipelineState(run.status, run.conclusion),
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
      jobs: this.workflowJobViews(jobs, appConfigured).map((job) => ({
        ...job,
        canRetry: false,
        retryUnavailableReason: "HISTORICAL_ATTEMPT",
      })),
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
      token,
    );
    let runs = result.workflow_runs;
    if (runs.length === 0 && worktree.branch) {
      const branchResult = await this.restRequest<{
        workflow_runs: RawActionsWorkflowRun[];
      }>(
        `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
          target.name,
        )}/actions/runs?branch=${encodeURIComponent(worktree.branch)}&per_page=100`,
        token,
      );
      const latestRemoteSha = branchResult.workflow_runs[0]?.head_sha;
      runs = latestRemoteSha
        ? branchResult.workflow_runs.filter(
            (run) => run.head_sha === latestRemoteSha,
          )
        : [];
    }
    return runs.map((run) => {
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
        startedAt: run.run_started_at ?? run.created_at,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      };
    });
  }

  async repositoryWorkflows(
    codebaseRepositoryId: string,
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
        token,
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
          token,
        );
        const run = latest.workflow_runs[0];
        const jobs = run
          ? await this.patWorkflowJobs(
              target.owner,
              target.name,
              String(run.id),
              token,
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
      token,
    );
    return result.workflow_runs.map((run) => {
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
        startedAt: run.run_started_at ?? run.created_at,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        jobs: [],
      };
    });
  }

  async autoRetryRun(
    repositoryId: string,
    workflowRunId: string,
    includeJobs = true,
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
      token,
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
      worktreeId: null,
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
          })
        ).githubRequestId;
      } else if (action === "FAILED_JOBS") {
        githubRequestId = (
          await rerunGitHubActionsFailedJobs(credentials, {
            owner: target.owner,
            repository: target.name,
            workflowRunId,
          })
        ).githubRequestId;
      } else {
        githubRequestId = (
          await rerunGitHubActionsWorkflow(credentials, {
            owner: target.owner,
            repository: target.name,
            workflowRunId,
          })
        ).githubRequestId;
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
      );
      if (!data.node) break;
      threads.push(...connectionNodes(data.node.reviewThreads));
      cursor = data.node.reviewThreads.pageInfo.hasNextPage
        ? data.node.reviewThreads.pageInfo.endCursor
        : null;
    }
    const normalized = await Promise.all(
      threads.map(async (thread) =>
        normalizeReviewThread(await this.completeReviewThread(thread, token)),
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

  private async searchReviewPullRequests(
    query: string,
    token: string,
  ): Promise<{ items: RawReviewPullRequest[]; truncated: boolean }> {
    const items: RawReviewPullRequest[] = [];
    let after: string | null = null;
    let truncated = false;
    while (true) {
      const data: { search: RawConnection<RawReviewPullRequest> } =
        await this.request(
          `query GitHubReviewThreadPullRequestSearch(
            $query: String!
            $after: String
          ) {
            search(query: $query, type: ISSUE, first: 50, after: $after) {
              nodes {
                ... on PullRequest {
                  id
                  number
                  title
                  url
                  updatedAt
                  repository { nameWithOwner }
                  reviewThreads(first: 50) {
                    nodes { ${REVIEW_THREAD_FIELDS} }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { query, after },
          token,
        );
      items.push(...connectionNodes(data.search));
      if (items.length >= SEARCH_RESULT_LIMIT) {
        truncated = data.search.pageInfo.hasNextPage;
        break;
      }
      if (!data.search.pageInfo.hasNextPage) break;
      after = data.search.pageInfo.endCursor;
    }
    return { items: items.slice(0, SEARCH_RESULT_LIMIT), truncated };
  }

  private async searchPullRequestPage(
    query: string,
    token: string,
    after: string | null,
  ): Promise<RawConnection<RawPullRequest>> {
    const data: {
      search: RawConnection<RawPullRequest>;
    } = await this.request(
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
      { query, after },
      token,
    );
    return data.search;
  }

  private async repositoryPullRequestPage(
    repository: GitHubRepositoryView,
    token: string,
    state: GitHubPullRequestStateFilter,
    after: string | null,
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
    );
    if (!data.repository) {
      throw new Error("Managed repository was not found or is not accessible");
    }
    return data.repository.pullRequests;
  }

  private async repositoryPullRequests(
    repository: GitHubRepositoryView,
    token: string,
  ): Promise<RawPullRequest[]> {
    const items: RawPullRequest[] = [];
    let after: string | null = null;
    while (true) {
      const connection = await this.repositoryPullRequestPage(
        repository,
        token,
        "OPEN",
        after,
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

  private async normalizePullRequest(
    pullRequest: RawPullRequest,
    jiraKeyRegex: string | null,
    token: string,
    appConfigured: boolean,
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
        )),
      );
    }
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
        )),
      );
    }
    return {
      id: pullRequest.id,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      repositoryGithubId: pullRequest.repository.id,
      repositoryNameWithOwner: pullRequest.repository.nameWithOwner,
      repositoryUrl: pullRequest.repository.url,
      labels,
      jiraKey: parseJiraKey(pullRequest.title, jiraKeyRegex),
      pipelineStatus: pipelineStatus(pullRequest.statusCheckRollup?.state),
      pipelines: normalizePipelines(pipelineContexts, appConfigured),
      reviewDecision: reviewDecision(pullRequest.reviewDecision),
      unresolvedReviewThreadCount,
      state: pullRequest.mergedAt ? "MERGED" : pullRequest.state,
      headRefName: pullRequest.headRefName,
      createdAt: pullRequest.createdAt,
    };
  }

  async pullRequests(
    scope: GitHubPullRequestScope,
    repositoryId?: string | null,
    options: {
      includePipelineJobs?: boolean;
      state?: GitHubPullRequestStateFilter;
      first?: number;
      after?: string | null;
    } = {},
  ): Promise<GitHubPullRequestPage> {
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
        ),
      );
    } else {
      if (repositoryId) {
        throw new Error(
          "repositoryId is only valid for repository pull requests",
        );
      }
      const viewer = await this.viewer(token);
      if (scope === "REVIEW_REQUESTED") {
        const query = pullRequestSearchQuery(
          "is:pr",
          searchState,
          `review-requested:${viewer.login}`,
          "sort:updated-desc",
        );
        loaders.set("review", (after) =>
          this.searchPullRequestPage(query, token, after),
        );
      } else if (scope === "MINE") {
        const authoredQuery = pullRequestSearchQuery(
          "is:pr",
          searchState,
          `author:${viewer.login}`,
          "sort:updated-desc",
        );
        const assignedQuery = pullRequestSearchQuery(
          "is:pr",
          searchState,
          `assignee:${viewer.login}`,
          `-author:${viewer.login}`,
          "sort:updated-desc",
        );
        loaders.set("authored", (after) =>
          this.searchPullRequestPage(authoredQuery, token, after),
        );
        loaders.set("assigned", (after) =>
          this.searchPullRequestPage(assignedQuery, token, after),
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

    const items = await Promise.all(
      rawItems.map((pullRequest) =>
        this.normalizePullRequest(
          pullRequest,
          regexByGitHubId.get(pullRequest.repository.id) ?? defaultJiraKeyRegex,
          token,
          appConfigured,
        ),
      ),
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
                return {
                  ...pipeline,
                  jobs: await this.workflowJobs(
                    owner,
                    name,
                    pipeline.workflowRunId,
                    token,
                    appCredentials,
                  ),
                };
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
    const viewer = await this.viewer(token);
    const prisma = await getPrismaClient();
    const repositories = await prisma.gitHubRepository.findMany();
    const searches = await Promise.all([
      this.searchReviewPullRequests(
        `is:pr is:open author:${viewer.login} sort:updated-desc`,
        token,
      ),
      this.searchReviewPullRequests(
        `is:pr is:open assignee:${viewer.login} sort:updated-desc`,
        token,
      ),
      this.searchReviewPullRequests(
        `is:pr is:open review-requested:${viewer.login} sort:updated-desc`,
        token,
      ),
      ...repositories.map((repository) =>
        this.searchReviewPullRequests(
          `is:pr is:open repo:${repository.nameWithOwner} sort:updated-desc`,
          token,
        ),
      ),
    ]);
    const unique = new Map<string, RawReviewPullRequest>();
    for (const search of searches) {
      for (const pullRequest of search.items) {
        unique.set(pullRequest.id, pullRequest);
      }
    }
    const pullRequests = [...unique.values()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
    const threads = (
      await Promise.all(
        pullRequests.map((pullRequest) =>
          this.completeReviewThreads(
            pullRequest.id,
            pullRequest.reviewThreads,
            token,
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
      viewerLogin: viewer.login,
      pullRequests: pullRequests.map(reviewThreadPullRequest),
      threads,
      truncated: searches.some((search) => search.truncated),
    };
  }

  async pullRequestForBranch(
    canonicalOrigin: string,
    branch: string,
  ): Promise<GitHubPullRequestView | null> {
    return (
      (await this.pullRequestsForOrigin(canonicalOrigin)).find(
        (pullRequest) =>
          (pullRequest as GitHubPullRequestView & { headRefName?: string })
            .headRefName === branch,
      ) ?? null
    );
  }

  async pullRequestsForOrigin(
    canonicalOrigin: string,
  ): Promise<Array<GitHubPullRequestView & { headRefName: string }>> {
    const match = canonicalOrigin.match(/^github\.com\/([^/]+)\/([^/]+)$/i);
    if (!match?.[1] || !match[2]) return [];
    const token = await this.requireToken();
    const owner = match[1];
    const name = match[2];
    const repository: GitHubRepositoryView = {
      id: canonicalOrigin,
      githubId: "",
      owner,
      name,
      nameWithOwner: `${owner}/${name}`,
      url: `https://github.com/${owner}/${name}`,
      jiraKeyRegex: null,
    };
    const [rawItems, appSettings] = await Promise.all([
      this.repositoryPullRequests(repository, token),
      (await getPrismaClient()).gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
      }),
    ]);
    const settings = await (
      await getPrismaClient()
    ).gitHubSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    const appConfigured =
      Boolean(appSettings) &&
      (await this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey));
    const matching = rawItems.filter(
      (pullRequest) =>
        pullRequest.headRepository?.nameWithOwner.toLowerCase() ===
        repository.nameWithOwner.toLowerCase(),
    );
    return Promise.all(
      matching.map(async (raw) => ({
        ...(await this.normalizePullRequest(
          raw,
          settings?.defaultJiraKeyRegex ?? DEFAULT_JIRA_KEY_REGEX,
          token,
          appConfigured,
        )),
        headRefName: raw.headRefName,
      })),
    );
  }

  async pullRequest(
    ownerValue: string,
    nameValue: string,
    number: number,
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
            ...PullRequestTableFields
            body
            bodyHTML
            author { login avatarUrl url }
            assignees(first: 100) {
              nodes { login avatarUrl url }
              pageInfo { hasNextPage endCursor }
            }
            reviewThreadsFull: reviewThreads(first: 100) {
              nodes { ${REVIEW_THREAD_FIELDS} }
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
      ${PULL_REQUEST_FRAGMENT}`,
      { owner, name, number },
      token,
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
            token,
          );
        } catch {
          // Attempt metadata is additive; preserve the existing PR pipeline when
          // GitHub does not expose the REST run to this token.
        }
        return {
          ...pipeline,
          workflowId: run
            ? String(run.workflow_id ?? pipeline.name)
            : pipeline.workflowId,
          runNumber: run?.run_number ?? pipeline.runNumber,
          runAttempt: run ? (run.run_attempt ?? 1) : pipeline.runAttempt,
          jobs: await this.workflowJobs(
            owner,
            name,
            workflowRunId,
            token,
            appSettings && appConfigured
              ? await this.appCredentials(appSettings)
              : null,
          ),
        };
      }),
    );
    const reviewThreads = await this.completeReviewThreads(
      pullRequest.id,
      pullRequest.reviewThreadsFull,
      token,
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
          select: { id: true },
        })
      : null;
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
            id title body url state isDraft mergeable mergeStateStatus headRefOid
          }
        }
      }`,
      { owner, name, number },
      token,
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
  ): Promise<{ emails: string[]; primaryEmail: string | null }> {
    const emails = new Set<string>();
    let primaryEmail: string | null = null;
    if (viewerEmail) emails.add(viewerEmail);
    try {
      const values = await this.restRequest<
        Array<{ email: string; verified: boolean; primary: boolean }>
      >(`${GITHUB_API_BASE_URL}/user/emails?per_page=100`, token);
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
  ): Promise<GitHubPullRequestMergeOptions> {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${ownerValue}/${nameValue}`,
    );
    if (!Number.isInteger(number) || number < 1) {
      throw new Error("Pull request number must be a positive integer");
    }
    const token = await this.requireToken();
    const state = await this.mergeState(owner, name, number, token);
    const commitEmailOptions = await this.commitEmailOptions(
      token,
      state.viewerEmail,
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
      blockedReason,
    };
  }

  async mergePullRequest(input: {
    owner: string;
    name: string;
    number: number;
    method: GitHubMergeMethod;
    commitHeadline: string;
    commitBody: string;
    authorEmail?: string | null;
  }): Promise<GitHubPullRequestMergeResult> {
    const { owner, name } = normalizeGitHubRepositoryName(
      `${input.owner}/${input.name}`,
    );
    if (!Number.isInteger(input.number) || input.number < 1) {
      throw new Error("Pull request number must be a positive integer");
    }
    const commitHeadline = input.commitHeadline.trim();
    if (!commitHeadline) throw new Error("A commit message is required");
    const token = await this.requireToken();
    const state = await this.mergeState(owner, name, input.number, token);
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
    );
    const pullRequest = data.mergePullRequest.pullRequest;
    if (!pullRequest)
      throw new Error("GitHub did not return the merged pull request");
    return pullRequest;
  }

  async replyToReviewThread(
    threadId: string,
    body: string,
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
    );
    const comment = data.addPullRequestReviewThreadReply.comment;
    if (!comment) throw new Error("GitHub did not return the new reply");
    return normalizeReviewComment(comment);
  }

  async setReviewThreadResolved(
    threadId: string,
    resolved: boolean,
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
    );
    const thread = data.unresolveReviewThread.thread;
    if (!thread) throw new Error("GitHub did not return the reopened thread");
    return normalizeReviewThreadState(thread);
  }

  async retryPipeline(
    repositoryId: string,
    checkSuiteId: string,
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
      const access = await githubAppGraphql<{
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
      });
      await this.audit(auditContext, {
        operation: "GITHUB_ACTIONS_WORKFLOW_RERUN",
        repositoryId,
        checkSuiteId,
        githubRequestId: result.githubRequestId,
        outcome: "SUCCESS",
      });
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
      const access = await githubAppGraphql<{
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
      });
      await this.audit(auditContext, {
        operation: "GITHUB_ACTIONS_JOB_RERUN",
        repositoryId,
        checkSuiteId,
        jobId,
        githubRequestId: result.githubRequestId,
        outcome: "SUCCESS",
      });
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
