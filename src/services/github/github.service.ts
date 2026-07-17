import { randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import {
  clearGitHubAppTokenCache,
  githubAppGraphql,
  GitHubAppError,
  listGitHubActionsWorkflowJobs,
  type GitHubActionsWorkflowJob,
  type GitHubAppCredentials,
  rerunGitHubActionsJob,
  rerunGitHubActionsWorkflow,
  verifyGitHubAppConfiguration,
} from "@/server/github/github-app";

import type {
  GitHubAppSettingsView,
  GitHubAuditContext,
  GitHubPipelineState,
  GitHubPipelineStatus,
  GitHubPipelineView,
  GitHubPullRequestDetail,
  GitHubPullRequestPage,
  GitHubPullRequestScope,
  GitHubPullRequestView,
  GitHubReviewComment,
  GitHubRepositoryCandidatePage,
  GitHubRepositoryView,
  GitHubReviewDecision,
  GitHubReviewThread,
  GitHubReviewThreadPage,
  GitHubReviewThreadPullRequest,
  GitHubReviewThreadState,
  GitHubSettingsView,
  GitHubViewer,
  GitHubWorkflowJobView,
} from "./types";

const SETTINGS_ID = "default";
const GITHUB_APP_SETTINGS_ID = "default";
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const SEARCH_RESULT_LIMIT = 1000;
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
    const appConfigured = appCredentials !== null;

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
      };
    });
  }

  private async patWorkflowJobs(
    owner: string,
    repository: string,
    workflowRunId: string,
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
        `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repository,
        )}/actions/runs/${encodeURIComponent(workflowRunId)}/jobs?filter=latest&per_page=100&page=${page}`,
        token,
      );
      totalCount = result.total_count;
      jobs.push(...result.jobs);
      page += 1;
    } while (jobs.length < totalCount);
    return jobs;
  }

  private async requireToken(): Promise<string> {
    const prisma = await getPrismaClient();
    const settings = await prisma.gitHubSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    if (!settings?.apiToken) {
      throw new Error("GitHub credentials are not configured");
    }
    return settings.apiToken;
  }

  async getSettings(): Promise<GitHubSettingsView> {
    const prisma = await getPrismaClient();
    const settings = await prisma.gitHubSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
    return {
      tokenConfigured: Boolean(settings.apiToken),
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  async saveSettings(input: {
    apiToken?: string | null;
  }): Promise<GitHubSettingsView> {
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    const nextToken = input.apiToken?.trim() || existing?.apiToken || null;
    if (!nextToken)
      throw new Error("A GitHub personal access token is required");
    await prisma.gitHubSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, apiToken: nextToken },
      update: { apiToken: nextToken },
    });
    return this.getSettings();
  }

  async clearCredentials(): Promise<GitHubSettingsView> {
    const prisma = await getPrismaClient();
    await prisma.gitHubSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: { apiToken: null },
    });
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
      privateKey: string;
      keyFingerprint: string;
      appSlug: string;
      accountLogin: string;
      repositorySelection: string;
      actionsPermission: string;
      verifiedAt: Date;
      updatedAt: Date;
    } | null,
  ): GitHubAppSettingsView {
    return {
      configured: Boolean(settings),
      appId: settings?.appId ?? null,
      installationId: settings?.installationId ?? null,
      privateKeyConfigured: Boolean(settings?.privateKey),
      keyFingerprint: settings?.keyFingerprint ?? null,
      appSlug: settings?.appSlug ?? null,
      accountLogin: settings?.accountLogin ?? null,
      repositorySelection: settings?.repositorySelection ?? null,
      actionsPermission: settings?.actionsPermission ?? null,
      verifiedAt: settings?.verifiedAt.toISOString() ?? null,
      updatedAt: settings?.updatedAt.toISOString() ?? null,
    };
  }

  async getAppSettings(): Promise<GitHubAppSettingsView> {
    const prisma = await getPrismaClient();
    return this.appSettingsView(
      await prisma.gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
      }),
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
        "A verified GitHub App is required to rerun GitHub Actions workflows",
      );
    }
    return this.appCredentials(settings);
  }

  private appCredentials(settings: {
    appId: string;
    installationId: string;
    privateKey: string;
    apiBaseUrl: string;
    graphqlUrl: string;
    keyFingerprint: string;
  }): GitHubAppCredentials {
    return {
      appId: settings.appId,
      installationId: settings.installationId,
      privateKey: settings.privateKey,
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
      const privateKey = replacementPrivateKey ?? existing?.privateKey;
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
      await prisma.gitHubAppSettings.upsert({
        where: { id: GITHUB_APP_SETTINGS_ID },
        create: {
          id: GITHUB_APP_SETTINGS_ID,
          appId: verification.appId,
          installationId: verification.installationId,
          privateKey,
          apiBaseUrl: GITHUB_API_BASE_URL,
          graphqlUrl: GITHUB_GRAPHQL_URL,
          keyFingerprint: verification.keyFingerprint,
          appSlug: verification.appSlug,
          accountLogin: verification.accountLogin,
          repositorySelection: verification.repositorySelection,
          actionsPermission: verification.actionsPermission,
          verifiedAt: verification.verifiedAt,
        },
        update: {
          appId: verification.appId,
          installationId: verification.installationId,
          privateKey,
          apiBaseUrl: GITHUB_API_BASE_URL,
          graphqlUrl: GITHUB_GRAPHQL_URL,
          keyFingerprint: verification.keyFingerprint,
          appSlug: verification.appSlug,
          accountLogin: verification.accountLogin,
          repositorySelection: verification.repositorySelection,
          actionsPermission: verification.actionsPermission,
          verifiedAt: verification.verifiedAt,
        },
      });
      await this.audit(auditContext, {
        operation: "GITHUB_APP_SETTINGS_SAVE",
        outcome: "SUCCESS",
        githubRequestId: verification.githubRequestId,
      });
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
    const prisma = await getPrismaClient();
    await prisma.gitHubAppSettings.deleteMany({
      where: { id: GITHUB_APP_SETTINGS_ID },
    });
    clearGitHubAppTokenCache();
    await this.audit(auditContext, {
      operation: "GITHUB_APP_SETTINGS_CLEAR",
      outcome: "SUCCESS",
    });
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

  async addRepository(input: {
    nameWithOwner: string;
    jiraKeyRegex?: string | null;
  }): Promise<GitHubRepositoryView[]> {
    const { owner, name } = normalizeGitHubRepositoryName(input.nameWithOwner);
    const jiraKeyRegex = normalizeJiraKeyRegex(
      input.jiraKeyRegex === undefined
        ? DEFAULT_JIRA_KEY_REGEX
        : input.jiraKeyRegex,
    );
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

  private async searchPullRequests(
    query: string,
    token: string,
  ): Promise<{ items: RawPullRequest[]; truncated: boolean }> {
    const items: RawPullRequest[] = [];
    let after: string | null = null;
    let truncated = false;
    while (true) {
      const data: {
        search: RawConnection<RawPullRequest>;
      } = await this.request(
        `query GitHubPullRequestSearch($query: String!, $after: String) {
          search(query: $query, type: ISSUE, first: 50, after: $after) {
            nodes { ...PullRequestTableFields }
            pageInfo { hasNextPage endCursor }
          }
        }
        ${PULL_REQUEST_FRAGMENT}`,
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

  private async repositoryPullRequests(
    repository: GitHubRepositoryView,
    token: string,
  ): Promise<RawPullRequest[]> {
    const items: RawPullRequest[] = [];
    let after: string | null = null;
    while (true) {
      const data: {
        repository: {
          pullRequests: RawConnection<RawPullRequest>;
        } | null;
      } = await this.request(
        `query GitHubRepositoryPullRequests(
          $owner: String!
          $name: String!
          $after: String
        ) {
          repository(owner: $owner, name: $name) {
            pullRequests(
              states: OPEN
              first: 50
              after: $after
              orderBy: { field: UPDATED_AT, direction: DESC }
            ) {
              nodes { ...PullRequestTableFields }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
        ${PULL_REQUEST_FRAGMENT}`,
        { owner: repository.owner, name: repository.name, after },
        token,
      );
      if (!data.repository) {
        throw new Error(
          "Managed repository was not found or is not accessible",
        );
      }
      items.push(...connectionNodes(data.repository.pullRequests));
      if (!data.repository.pullRequests.pageInfo.hasNextPage) break;
      after = data.repository.pullRequests.pageInfo.endCursor;
    }
    return items;
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
      createdAt: pullRequest.createdAt,
    };
  }

  async pullRequests(
    scope: GitHubPullRequestScope,
    repositoryId?: string | null,
    options: { includePipelineJobs?: boolean } = {},
  ): Promise<GitHubPullRequestPage> {
    const token = await this.requireToken();
    const prisma = await getPrismaClient();
    const repositories = await prisma.gitHubRepository.findMany();
    const appSettings = await prisma.gitHubAppSettings.findUnique({
      where: { id: GITHUB_APP_SETTINGS_ID },
    });
    const appConfigured = Boolean(appSettings);
    const appCredentials = appSettings
      ? this.appCredentials(appSettings)
      : null;
    const regexByGitHubId = new Map(
      repositories.map((repository) => [
        repository.githubId,
        repository.jiraKeyRegex,
      ]),
    );
    let rawItems: RawPullRequest[];
    let truncated = false;

    if (scope === "REPOSITORY") {
      if (!repositoryId) {
        throw new Error(
          "repositoryId is required for repository pull requests",
        );
      }
      const repository = repositories.find((item) => item.id === repositoryId);
      if (!repository) throw new Error("Managed repository was not found");
      rawItems = await this.repositoryPullRequests(
        repositoryView(repository),
        token,
      );
    } else {
      if (repositoryId) {
        throw new Error(
          "repositoryId is only valid for repository pull requests",
        );
      }
      const viewer = await this.viewer(token);
      if (scope === "REVIEW_REQUESTED") {
        const result = await this.searchPullRequests(
          `is:pr is:open review-requested:${viewer.login} sort:updated-desc`,
          token,
        );
        rawItems = result.items;
        truncated = result.truncated;
      } else if (scope === "MINE") {
        const [authored, assigned] = await Promise.all([
          this.searchPullRequests(
            `is:pr is:open author:${viewer.login} sort:updated-desc`,
            token,
          ),
          this.searchPullRequests(
            `is:pr is:open assignee:${viewer.login} sort:updated-desc`,
            token,
          ),
        ]);
        const unique = new Map<string, RawPullRequest>();
        for (const pullRequest of [...authored.items, ...assigned.items]) {
          unique.set(pullRequest.id, pullRequest);
        }
        rawItems = [...unique.values()].sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        );
        truncated = authored.truncated || assigned.truncated;
      } else {
        throw new Error("Unknown GitHub pull request scope");
      }
    }

    const items = await Promise.all(
      rawItems.map((pullRequest) =>
        this.normalizePullRequest(
          pullRequest,
          regexByGitHubId.get(pullRequest.repository.id) ?? null,
          token,
          appConfigured,
        ),
      ),
    );
    if (!options.includePipelineJobs) return { items, truncated };

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
    const matching = rawItems.filter(
      (pullRequest) =>
        pullRequest.headRepository?.nameWithOwner.toLowerCase() ===
        repository.nameWithOwner.toLowerCase(),
    );
    return Promise.all(
      matching.map(async (raw) => ({
        ...(await this.normalizePullRequest(
          raw,
          null,
          token,
          Boolean(appSettings),
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
    const [managedRepositories, appSettings] = await Promise.all([
      prisma.gitHubRepository.findMany(),
      prisma.gitHubAppSettings.findUnique({
        where: { id: GITHUB_APP_SETTINGS_ID },
      }),
    ]);
    const managedRepository = managedRepositories.find(
      (repository) => repository.githubId === pullRequest.repository.id,
    );
    const summary = await this.normalizePullRequest(
      pullRequest,
      managedRepository?.jiraKeyRegex ?? null,
      token,
      Boolean(appSettings),
    );
    const pipelines = await Promise.all(
      summary.pipelines.map(async (pipeline) => {
        const workflowRunId = pipeline.workflowRunId;
        if (!workflowRunId) return pipeline;
        return {
          ...pipeline,
          jobs: await this.workflowJobs(
            owner,
            name,
            workflowRunId,
            token,
            appSettings ? this.appCredentials(appSettings) : null,
          ),
        };
      }),
    );
    const reviewThreads = await this.completeReviewThreads(
      pullRequest.id,
      pullRequest.reviewThreadsFull,
      token,
    );
    return {
      ...summary,
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
    };
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
