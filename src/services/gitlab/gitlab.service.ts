import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";

import { getPrismaClient } from "@/data/prisma-client";
import {
  CREDENTIALS,
  CredentialService,
  encodeJsonCredential,
} from "@/services/credentials";
import {
  gitlabConnectionSettings,
  readConnectionSettings,
  type GitLabConnectionSettings,
} from "@/services/credentials/connection-settings";
import type { WorkflowEventsService } from "@/services/workflows/workflow-events.service";
import type { PollingService } from "@/services/polling";
import { agentEventBus } from "@/services/agent-control";
import type { NotificationsService } from "@/services/notifications";

import type {
  GitLabApiCallView,
  GitLabAutoRetryRuleView,
  GitLabCacheEntryDetailView,
  GitLabCacheEntryView,
  GitLabDiscussionView,
  GitLabJobView,
  GitLabMergeRequestDetailView,
  GitLabMergeRequestScope,
  GitLabMergeRequestState,
  GitLabMergeRequestView,
  GitLabPipelineMergeRequestView,
  GitLabPipelineStatus,
  GitLabPipelineView,
  GitLabProjectCandidateView,
  GitLabProjectView,
  GitLabRequestSource,
  GitLabReviewOutcome,
  GitLabSettingsView,
  GitLabUserView,
  GitLabWebhookDeliveryView,
  GitLabWebhookSetupView,
  Paginated,
} from "./types";

const SETTINGS_ID = "default";
const MIN_GITLAB_VERSION = { major: 19, minor: 2 };
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_PAGE_SIZE = 100;
const WEBHOOK_REPLAY_WINDOW_SECONDS = 5 * 60;
export const GITLAB_PIPELINE_STATUS_CHANGED_TOPIC =
  "gitlab:pipeline-status-changed";
const WEBHOOK_EVENTS = {
  merge_requests_events: true,
  note_events: true,
  pipeline_events: true,
  job_events: true,
  push_events: true,
  enable_ssl_verification: true,
} as const;

type QueryValue = string | number | boolean | null | undefined;
type Query = Record<string, QueryValue | QueryValue[]>;
type WebhookSecrets = Record<string, string>;

type RateLimit = {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
  requestId: string | null;
};

type RawResponse<T> = {
  data: T;
  status: number;
  headers: Headers;
  endpoint: string;
  rateLimit: RateLimit;
};

type RawGitLabUser = {
  id: number;
  username: string;
  name: string;
  avatar_url?: string | null;
  web_url: string;
};

type RawGitLabProject = {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch?: string | null;
  visibility: string;
};

type RawGitLabPipeline = {
  id: number;
  iid?: number | null;
  project_id: number;
  ref: string;
  sha: string;
  source: string;
  status: string;
  web_url: string;
  started_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
  duration?: number | null;
  queued_duration?: number | null;
};

type RawGitLabJob = {
  id: number;
  pipeline: { id: number };
  name: string;
  stage: string;
  status: string;
  ref: string;
  web_url: string;
  allow_failure: boolean;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration?: number | null;
  queued_duration?: number | null;
  retried?: boolean;
};

type RawGitLabMergeRequest = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: string;
  draft?: boolean;
  web_url: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  author: RawGitLabUser;
  reviewers?: RawGitLabUser[];
  labels?: string[];
  detailed_merge_status?: string;
  merge_when_pipeline_succeeds?: boolean;
  squash_on_merge?: boolean;
  has_conflicts?: boolean;
  blocking_discussions_resolved?: boolean;
  changes_count?: string | null;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
};

type RawGitLabDiscussion = {
  id: string;
  individual_note: boolean;
  notes: Array<{
    id: number;
    body: string;
    author: RawGitLabUser;
    created_at: string;
    updated_at: string;
    system: boolean;
    resolvable: boolean;
    resolved?: boolean | null;
    resolved_by?: RawGitLabUser | null;
  }>;
};

export class GitLabRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "GitLabRequestError";
  }
}

function json(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        canonicalize((value as Record<string, unknown>)[key]),
      ]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sanitizedError(error: unknown, token?: string | null): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (token ? raw.replaceAll(token, "[REDACTED]") : raw).slice(0, 1000);
}

function positiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseGitLabRateLimitHeaders(headers: Headers): RateLimit {
  const reset = positiveInt(headers.get("ratelimit-reset"));
  return {
    limit: positiveInt(headers.get("ratelimit-limit")),
    remaining: positiveInt(headers.get("ratelimit-remaining")),
    resetAt: reset === null ? null : new Date(reset * 1000),
    requestId: headers.get("x-request-id"),
  };
}

function pageValue(value: string | null): number | null {
  const parsed = positiveInt(value);
  return parsed && parsed > 0 ? parsed : null;
}

function mapUser(user: RawGitLabUser): GitLabUserView {
  return {
    id: String(user.id),
    username: user.username,
    name: user.name,
    avatarUrl: user.avatar_url ?? null,
    webUrl: user.web_url,
  };
}

export function mapGitLabPipelineStatus(status: string): GitLabPipelineStatus {
  const normalized = status.toUpperCase();
  const supported = new Set<string>([
    "CREATED",
    "WAITING_FOR_RESOURCE",
    "PREPARING",
    "PENDING",
    "RUNNING",
    "SUCCESS",
    "FAILED",
    "CANCELED",
    "SKIPPED",
    "MANUAL",
    "SCHEDULED",
  ]);
  return supported.has(normalized)
    ? (normalized as GitLabPipelineStatus)
    : "UNKNOWN";
}

function mapPipeline(pipeline: RawGitLabPipeline): GitLabPipelineView {
  return {
    id: String(pipeline.id),
    projectId: String(pipeline.project_id),
    iid: pipeline.iid == null ? null : String(pipeline.iid),
    ref: pipeline.ref,
    branch: pipeline.ref,
    sha: pipeline.sha,
    source: pipeline.source,
    status: mapGitLabPipelineStatus(pipeline.status),
    webUrl: pipeline.web_url,
    mergeRequests: [],
    worktreeId: null,
    worktreeHighlightColor: null,
    startedAt: pipeline.started_at ?? pipeline.created_at ?? null,
    createdAt: pipeline.created_at ?? null,
    updatedAt: pipeline.updated_at ?? null,
    finishedAt: pipeline.finished_at ?? null,
    duration: pipeline.duration ?? null,
    queuedDuration: pipeline.queued_duration ?? null,
  };
}

export function resolveGitLabPipelineBranch(
  pipeline: Pick<GitLabPipelineView, "ref" | "source">,
  mergeRequests: GitLabPipelineMergeRequestView[],
): string {
  const syntheticRef = pipeline.ref.match(
    /^refs\/merge-requests\/(\d+)\/(?:head|merge)$/,
  );
  const matchingMergeRequest = syntheticRef
    ? mergeRequests.find(
        (mergeRequest) => mergeRequest.iid === Number(syntheticRef[1]),
      )
    : mergeRequests.find(
        (mergeRequest) => mergeRequest.sourceBranch === pipeline.ref,
      );
  if (matchingMergeRequest) return matchingMergeRequest.sourceBranch;
  if (pipeline.source === "merge_request_event" && mergeRequests[0]) {
    return mergeRequests[0].sourceBranch;
  }
  return pipeline.ref;
}

function mapJob(job: RawGitLabJob): GitLabJobView {
  return {
    id: String(job.id),
    pipelineId: String(job.pipeline.id),
    name: job.name,
    stage: job.stage,
    status: mapGitLabPipelineStatus(job.status),
    ref: job.ref,
    webUrl: job.web_url,
    allowFailure: job.allow_failure,
    createdAt: job.created_at ?? null,
    startedAt: job.started_at ?? null,
    finishedAt: job.finished_at ?? null,
    duration: job.duration ?? null,
    queuedDuration: job.queued_duration ?? null,
    retried: job.retried ?? false,
  };
}

function mapMergeRequest(mr: RawGitLabMergeRequest): GitLabMergeRequestView {
  return {
    id: String(mr.id),
    iid: mr.iid,
    projectId: String(mr.project_id),
    title: mr.title,
    description: mr.description ?? "",
    state: mr.state.toUpperCase(),
    draft: mr.draft ?? false,
    webUrl: mr.web_url,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    sha: mr.sha,
    author: mapUser(mr.author),
    reviewers: (mr.reviewers ?? []).map(mapUser),
    labels: mr.labels ?? [],
    detailedMergeStatus: mr.detailed_merge_status ?? "unchecked",
    mergeWhenPipelineSucceeds: mr.merge_when_pipeline_succeeds ?? false,
    squashOnMerge: mr.squash_on_merge ?? false,
    hasConflicts: mr.has_conflicts ?? false,
    blockingDiscussionsResolved: mr.blocking_discussions_resolved ?? true,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    mergedAt: mr.merged_at ?? null,
  };
}

export function mapGitLabDiscussion(
  discussion: RawGitLabDiscussion,
): GitLabDiscussionView {
  return {
    id: discussion.id,
    individualNote: discussion.individual_note,
    notes: discussion.notes.map((note) => ({
      id: String(note.id),
      body: note.body,
      author: mapUser(note.author),
      createdAt: note.created_at,
      updatedAt: note.updated_at,
      system: note.system,
      resolvable: note.resolvable,
      resolved: note.resolved ?? false,
      resolvedBy: note.resolved_by ? mapUser(note.resolved_by) : null,
    })),
  };
}

function mapProject(row: {
  id: string;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  defaultBranch: string | null;
  visibility: string;
  enabled: boolean;
  webhookId: string | null;
  webhookState: string;
  webhookError: string | null;
  webhookConfiguredAt: Date | null;
  webhookLastReceivedAt: Date | null;
}): GitLabProjectView {
  return {
    ...row,
    webhookConfiguredAt: row.webhookConfiguredAt?.toISOString() ?? null,
    webhookLastReceivedAt: row.webhookLastReceivedAt?.toISOString() ?? null,
  };
}

export function normalizeGitLabBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The GitLab instance URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("The GitLab instance URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "The GitLab instance URL must not contain credentials, a query, or a fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function apiRoot(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v4/`;
  return url;
}

export function gitLabVersionSupported(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > MIN_GITLAB_VERSION.major ||
    (major === MIN_GITLAB_VERSION.major && minor >= MIN_GITLAB_VERSION.minor)
  );
}

function buildQuery(query: Query | undefined): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(query ?? {}).sort()) {
    const values = Array.isArray(query?.[key]) ? query?.[key] : [query?.[key]];
    for (const value of values ?? []) {
      if (value !== undefined && value !== null)
        params.append(key, String(value));
    }
  }
  return params;
}

export function gitLabRestCacheKey(input: {
  baseUrl: string;
  operation: string;
  path: string;
  query?: Query;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        instance: createHash("sha256").update(input.baseUrl).digest("hex"),
        operation: input.operation,
        path: input.path,
        query: [...buildQuery(input.query).entries()].sort(
          ([firstKey, firstValue], [secondKey, secondValue]) =>
            firstKey.localeCompare(secondKey) ||
            firstValue.localeCompare(secondValue),
        ),
      }),
    )
    .digest("hex");
}

export function gitLabWebhookProjectId(
  payload: Record<string, unknown>,
): string | null {
  const project = payload.project;
  if (project && typeof project === "object" && "id" in project) {
    return String((project as { id: unknown }).id);
  }
  return typeof payload.project_id === "number"
    ? String(payload.project_id)
    : null;
}

export function verifyGitLabWebhookSignature(input: {
  rawBody: string;
  webhookId: string;
  timestamp: string;
  signature: string;
  signingToken: string;
  now?: number;
}): void {
  const seconds = Number(input.timestamp);
  const now = input.now ?? Date.now();
  if (
    !Number.isFinite(seconds) ||
    Math.abs(now / 1000 - seconds) > WEBHOOK_REPLAY_WINDOW_SECONDS
  ) {
    throw new Error("GitLab webhook timestamp is outside the replay window");
  }
  if (!input.signingToken.startsWith("whsec_")) {
    throw new Error("Invalid GitLab webhook signing token");
  }
  const key = Buffer.from(input.signingToken.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key)
    .update(`${input.webhookId}.${input.timestamp}.${input.rawBody}`)
    .digest();
  const candidates = input.signature.split(/\s+/).flatMap((item) => {
    const [version, encoded] = item.split(",", 2);
    if (version !== "v1" || !encoded) return [];
    try {
      return [Buffer.from(encoded, "base64")];
    } catch {
      return [];
    }
  });
  if (
    !candidates.some(
      (candidate) =>
        candidate.length === expected.length &&
        timingSafeEqual(candidate, expected),
    )
  ) {
    throw new Error("Invalid GitLab webhook signature");
  }
}

export class GitLabService {
  private autoRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly credentials = new CredentialService(),
    private readonly workflowEvents?: WorkflowEventsService,
    private readonly polling?: PollingService,
    private readonly notifications?: NotificationsService,
  ) {
    if (this.polling) {
      this.polling.register({
        id: "server:gitlab-auto-retry",
        kind: "GITLAB_AUTO_RETRY",
        runtime: "SERVER",
        enabled: true,
        cadenceSeconds: 60,
        details: {},
      });
      queueMicrotask(() => void this.pollAutoRetry());
    }
  }

  subscribePipelineStatuses() {
    return agentEventBus.iterate<{
      gitlabPipelineStatusChanged: GitLabPipelineView;
    }>(GITLAB_PIPELINE_STATUS_CHANGED_TOPIC);
  }

  private publishPipeline(pipeline: GitLabPipelineView): void {
    agentEventBus.publish(GITLAB_PIPELINE_STATUS_CHANGED_TOPIC, {
      gitlabPipelineStatusChanged: pipeline,
    });
  }

  private scheduleAutoRetry(seconds: number): void {
    if (!this.polling) return;
    if (this.autoRetryTimer) clearTimeout(this.autoRetryTimer);
    const delay = Math.max(30, seconds) * 1_000;
    this.autoRetryTimer = setTimeout(() => void this.pollAutoRetry(), delay);
    this.autoRetryTimer.unref();
    this.polling.schedule(
      "server:gitlab-auto-retry",
      new Date(Date.now() + delay),
    );
  }

  private async pollAutoRetry(): Promise<void> {
    if (!this.polling) return;
    let interval = 60;
    try {
      const settings = await this.getSettings();
      interval = settings.pipelinePollIntervalSeconds;
      this.polling.configure("server:gitlab-auto-retry", {
        enabled: settings.configured,
        cadenceSeconds: interval,
      });
      if (settings.configured) {
        await this.polling.run(
          "server:gitlab-auto-retry",
          () => this.reconcileAutoRetries(),
          (activeRules) => ({ activeRules }),
        );
      }
    } catch {
      // Polling status exposes the error and the scheduled run retries it.
    } finally {
      this.scheduleAutoRetry(interval);
    }
  }

  private async connection(): Promise<{
    baseUrl: string;
    token: string;
  }> {
    const [settings, token] = await Promise.all([
      readConnectionSettings(
        this.credentials,
        CREDENTIALS.gitlabConnectionSettings,
        gitlabConnectionSettings,
      ),
      this.credentials.getText(CREDENTIALS.gitlabAccessToken),
    ]);
    if (!settings || !token)
      throw new Error("GitLab credentials are not configured");
    return { baseUrl: settings.value.baseUrl, token };
  }

  private endpoint(baseUrl: string, path: string, query?: Query): URL {
    if (!path.startsWith("/"))
      throw new Error("GitLab API paths must be relative");
    const root = apiRoot(baseUrl);
    const url = new URL(path.slice(1), root);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
      throw new Error(
        "GitLab API request escaped the configured instance root",
      );
    }
    url.search = buildQuery(query).toString();
    return url;
  }

  private async fetchRaw<T>(input: {
    baseUrl: string;
    token: string;
    path: string;
    method?: string;
    query?: Query;
    body?: unknown;
  }): Promise<RawResponse<T>> {
    const url = this.endpoint(input.baseUrl, input.path, input.query);
    const response = await fetch(url, {
      method: input.method ?? "GET",
      headers: {
        Accept: "application/json",
        "PRIVATE-TOKEN": input.token,
        ...(input.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      cache: "no-store",
      redirect: "manual",
    });
    const metadata = parseGitLabRateLimitHeaders(response.headers);
    if (response.status >= 300 && response.status < 400) {
      throw new GitLabRequestError(
        "GitLab redirected the API request; configure the canonical instance URL",
        response.status,
        metadata.requestId,
      );
    }
    const text = await response.text();
    const parsed = text ? json(text) : null;
    if (!response.ok) {
      const detail =
        parsed && typeof parsed === "object" && "message" in parsed
          ? JSON.stringify((parsed as { message: unknown }).message)
          : text;
      throw new GitLabRequestError(
        `GitLab API request failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        response.status,
        metadata.requestId,
      );
    }
    return {
      data: parsed as T,
      status: response.status,
      headers: response.headers,
      endpoint: url.toString(),
      rateLimit: metadata,
    };
  }

  private async recordRateLimit(metadata: RateLimit): Promise<void> {
    if (metadata.limit === null || metadata.remaining === null) return;
    const prisma = await getPrismaClient();
    await prisma.gitLabRateLimitSnapshot.upsert({
      where: { resource: "REST" },
      create: {
        id: randomUUID(),
        resource: "REST",
        limit: metadata.limit,
        remaining: metadata.remaining,
        resetAt: metadata.resetAt,
        observedAt: new Date(),
      },
      update: {
        limit: metadata.limit,
        remaining: metadata.remaining,
        resetAt: metadata.resetAt,
        observedAt: new Date(),
      },
    });
  }

  private async logCall(input: {
    method: string;
    endpoint: string;
    operation: string;
    requestSource: GitLabRequestSource;
    requestSummary: string;
    source: "LIVE" | "CACHE" | "ERROR";
    durationMs: number;
    statusCode?: number | null;
    error?: string | null;
    servedStale?: boolean;
    rateLimit?: RateLimit | null;
  }): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.gitLabApiCallLog.create({
      data: {
        id: randomUUID(),
        method: input.method,
        endpoint: input.endpoint,
        operation: input.operation,
        requestSource: input.requestSource,
        requestSummary: input.requestSummary,
        source: input.source,
        durationMs: input.durationMs,
        statusCode: input.statusCode ?? null,
        error: input.error ?? null,
        servedStale: input.servedStale ?? false,
        rateLimitLimit: input.rateLimit?.limit ?? null,
        rateLimitRemaining: input.rateLimit?.remaining ?? null,
        rateLimitResetAt: input.rateLimit?.resetAt ?? null,
        requestId: input.rateLimit?.requestId ?? null,
      },
    });
  }

  private async ttl(operation: string): Promise<number> {
    const prisma = await getPrismaClient();
    const [override, settings] = await Promise.all([
      prisma.gitLabRestCacheTtlOverride.findUnique({ where: { operation } }),
      prisma.gitLabSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID },
        update: {},
      }),
    ]);
    return override?.ttlSeconds ?? settings.cacheTtlSeconds;
  }

  private async get<T>(input: {
    path: string;
    operation: string;
    source: GitLabRequestSource;
    query?: Query;
    force?: boolean;
    allowStaleOnError?: boolean;
  }): Promise<RawResponse<T>> {
    const connection = await this.connection();
    const endpoint = this.endpoint(
      connection.baseUrl,
      input.path,
      input.query,
    ).toString();
    const request = { path: input.path, query: input.query ?? {} };
    const cacheKey = gitLabRestCacheKey({
      baseUrl: connection.baseUrl,
      operation: input.operation,
      path: input.path,
      query: input.query,
    });
    const prisma = await getPrismaClient();
    const cached = await prisma.gitLabRestCacheEntry.findUnique({
      where: { cacheKey },
    });
    const ttl = await this.ttl(input.operation);
    if (
      cached &&
      input.force !== true &&
      Date.now() - cached.fetchedAt.getTime() < ttl * 1000
    ) {
      await this.logCall({
        method: "GET",
        endpoint,
        operation: input.operation,
        requestSource: input.source,
        requestSummary: stableStringify(request),
        source: "CACHE",
        durationMs: 0,
        statusCode: 200,
      });
      return {
        data: json(cached.responseJson) as T,
        status: 200,
        headers: new Headers(),
        endpoint,
        rateLimit: {
          limit: null,
          remaining: null,
          resetAt: null,
          requestId: null,
        },
      };
    }
    const startedAt = Date.now();
    try {
      const response = await this.fetchRaw<T>({
        ...connection,
        path: input.path,
        query: input.query,
      });
      await Promise.all([
        prisma.gitLabRestCacheEntry.upsert({
          where: { cacheKey },
          create: {
            id: randomUUID(),
            cacheKey,
            endpoint,
            operation: input.operation,
            requestJson: stableStringify(request),
            responseJson: JSON.stringify(response.data),
            fetchedAt: new Date(),
          },
          update: {
            endpoint,
            operation: input.operation,
            requestJson: stableStringify(request),
            responseJson: JSON.stringify(response.data),
            fetchedAt: new Date(),
          },
        }),
        this.recordRateLimit(response.rateLimit),
        this.logCall({
          method: "GET",
          endpoint,
          operation: input.operation,
          requestSource: input.source,
          requestSummary: stableStringify(request),
          source: "LIVE",
          durationMs: Date.now() - startedAt,
          statusCode: response.status,
          rateLimit: response.rateLimit,
        }),
      ]);
      return response;
    } catch (error) {
      const statusCode =
        error instanceof GitLabRequestError ? error.statusCode : null;
      if (cached && input.allowStaleOnError !== false) {
        await this.logCall({
          method: "GET",
          endpoint,
          operation: input.operation,
          requestSource: input.source,
          requestSummary: stableStringify(request),
          source: "CACHE",
          durationMs: Date.now() - startedAt,
          statusCode,
          error: sanitizedError(error, connection.token),
          servedStale: true,
        });
        return {
          data: json(cached.responseJson) as T,
          status: 200,
          headers: new Headers(),
          endpoint,
          rateLimit: {
            limit: null,
            remaining: null,
            resetAt: null,
            requestId: null,
          },
        };
      }
      await this.logCall({
        method: "GET",
        endpoint,
        operation: input.operation,
        requestSource: input.source,
        requestSummary: stableStringify(request),
        source: "ERROR",
        durationMs: Date.now() - startedAt,
        statusCode,
        error: sanitizedError(error, connection.token),
      });
      throw error;
    }
  }

  private async mutate<T>(input: {
    method: "POST" | "PUT" | "DELETE";
    path: string;
    operation: string;
    source: GitLabRequestSource;
    body?: unknown;
    invalidateProjectId?: string;
  }): Promise<T> {
    const connection = await this.connection();
    const endpoint = this.endpoint(connection.baseUrl, input.path).toString();
    const startedAt = Date.now();
    try {
      const response = await this.fetchRaw<T>({
        ...connection,
        path: input.path,
        method: input.method,
        body: input.body,
      });
      await Promise.all([
        this.recordRateLimit(response.rateLimit),
        this.logCall({
          method: input.method,
          endpoint,
          operation: input.operation,
          requestSource: input.source,
          requestSummary: stableStringify(input.body ?? {}),
          source: "LIVE",
          durationMs: Date.now() - startedAt,
          statusCode: response.status,
          rateLimit: response.rateLimit,
        }),
        this.invalidateCache(input.invalidateProjectId),
      ]);
      return response.data;
    } catch (error) {
      await this.logCall({
        method: input.method,
        endpoint,
        operation: input.operation,
        requestSource: input.source,
        requestSummary: stableStringify(input.body ?? {}),
        source: "ERROR",
        durationMs: Date.now() - startedAt,
        statusCode:
          error instanceof GitLabRequestError ? error.statusCode : null,
        error: sanitizedError(error, connection.token),
      });
      throw error;
    }
  }

  private async invalidateCache(projectId?: string): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.gitLabRestCacheEntry.deleteMany(
      projectId
        ? {
            where: {
              endpoint: {
                contains: `/projects/${encodeURIComponent(projectId)}/`,
              },
            },
          }
        : undefined,
    );
  }

  async getSettings(): Promise<GitLabSettingsView> {
    const prisma = await getPrismaClient();
    const [row, connection, tokenConfigured] = await Promise.all([
      prisma.gitLabSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID },
        update: {},
      }),
      readConnectionSettings(
        this.credentials,
        CREDENTIALS.gitlabConnectionSettings,
        gitlabConnectionSettings,
      ),
      this.credentials.isConfigured(CREDENTIALS.gitlabAccessToken),
    ]);
    const viewer =
      row.currentUserId &&
      row.currentUsername &&
      row.currentUserName &&
      row.currentUserWebUrl
        ? {
            id: row.currentUserId,
            username: row.currentUsername,
            name: row.currentUserName,
            avatarUrl: row.currentUserAvatarUrl,
            webUrl: row.currentUserWebUrl,
          }
        : null;
    return {
      configured: Boolean(connection && tokenConfigured && row.verifiedAt),
      tokenConfigured,
      baseUrl: connection?.value.baseUrl ?? null,
      version: row.version,
      revision: row.revision,
      viewer,
      pipelinePollIntervalSeconds: row.pipelinePollIntervalSeconds,
      cacheTtlSeconds: row.cacheTtlSeconds,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async verify(settings: GitLabConnectionSettings, token: string) {
    const [user, version] = await Promise.all([
      this.fetchRaw<RawGitLabUser>({
        baseUrl: settings.baseUrl,
        token,
        path: "/user",
      }),
      this.fetchRaw<{ version: string; revision?: string }>({
        baseUrl: settings.baseUrl,
        token,
        path: "/version",
      }),
    ]);
    if (!gitLabVersionSupported(version.data.version)) {
      throw new Error(
        `GitLab ${MIN_GITLAB_VERSION.major}.${MIN_GITLAB_VERSION.minor} or later is required; the instance reported ${version.data.version}`,
      );
    }
    return { user: user.data, version: version.data };
  }

  async saveSettings(input: {
    baseUrl: string;
    accessToken?: string | null;
    pipelinePollIntervalSeconds?: number | null;
  }): Promise<GitLabSettingsView> {
    const baseUrl = normalizeGitLabBaseUrl(input.baseUrl);
    const existingToken = await this.credentials.getText(
      CREDENTIALS.gitlabAccessToken,
    );
    const token = input.accessToken?.trim() || existingToken;
    if (!token)
      throw new Error("A GitLab access token with api scope is required");
    const pollInterval = input.pipelinePollIntervalSeconds ?? 60;
    if (
      !Number.isInteger(pollInterval) ||
      pollInterval < 30 ||
      pollInterval > 3600
    ) {
      throw new Error(
        "GitLab pipeline polling interval must be from 30 to 3600 seconds",
      );
    }
    const verified = await this.verify({ baseUrl }, token);
    const entries = [
      {
        descriptor: CREDENTIALS.gitlabConnectionSettings,
        value: encodeJsonCredential({ baseUrl }),
      },
      ...(input.accessToken?.trim() || !existingToken
        ? [
            {
              descriptor: CREDENTIALS.gitlabAccessToken,
              value: Buffer.from(token, "utf8"),
            },
          ]
        : []),
    ];
    await this.credentials.setMany(entries, async (transaction) => {
      await transaction.gitLabSettings.upsert({
        where: { id: SETTINGS_ID },
        create: {
          id: SETTINGS_ID,
          currentUserId: String(verified.user.id),
          currentUsername: verified.user.username,
          currentUserName: verified.user.name,
          currentUserAvatarUrl: verified.user.avatar_url ?? null,
          currentUserWebUrl: verified.user.web_url,
          version: verified.version.version,
          revision: verified.version.revision ?? null,
          verifiedAt: new Date(),
          pipelinePollIntervalSeconds: pollInterval,
        },
        update: {
          currentUserId: String(verified.user.id),
          currentUsername: verified.user.username,
          currentUserName: verified.user.name,
          currentUserAvatarUrl: verified.user.avatar_url ?? null,
          currentUserWebUrl: verified.user.web_url,
          version: verified.version.version,
          revision: verified.version.revision ?? null,
          verifiedAt: new Date(),
          pipelinePollIntervalSeconds: pollInterval,
        },
      });
    });
    await this.invalidateCache();
    return this.getSettings();
  }

  async testConnection(): Promise<GitLabSettingsView> {
    const connection = await this.connection();
    const verified = await this.verify(
      { baseUrl: connection.baseUrl },
      connection.token,
    );
    const prisma = await getPrismaClient();
    await prisma.gitLabSettings.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        currentUserId: String(verified.user.id),
        currentUsername: verified.user.username,
        currentUserName: verified.user.name,
        currentUserAvatarUrl: verified.user.avatar_url ?? null,
        currentUserWebUrl: verified.user.web_url,
        version: verified.version.version,
        revision: verified.version.revision ?? null,
        verifiedAt: new Date(),
      },
      update: {
        currentUserId: String(verified.user.id),
        currentUsername: verified.user.username,
        currentUserName: verified.user.name,
        currentUserAvatarUrl: verified.user.avatar_url ?? null,
        currentUserWebUrl: verified.user.web_url,
        version: verified.version.version,
        revision: verified.version.revision ?? null,
        verifiedAt: new Date(),
      },
    });
    return this.getSettings();
  }

  async clearCredentials(force = false): Promise<GitLabSettingsView> {
    const projects = await this.projects();
    const failures: string[] = [];
    for (const project of projects.filter((item) => item.webhookId)) {
      try {
        await this.removeProjectWebhook(project.id);
      } catch {
        failures.push(project.pathWithNamespace);
      }
    }
    if (failures.length && !force) {
      throw new Error(
        `Could not remove AIDE-managed webhooks from: ${failures.join(", ")}. Retry or force removal.`,
      );
    }
    await this.credentials.deleteMany([
      CREDENTIALS.gitlabConnectionSettings,
      CREDENTIALS.gitlabAccessToken,
      CREDENTIALS.gitlabWebhookSigningSecrets,
    ]);
    const prisma = await getPrismaClient();
    await prisma.$transaction([
      prisma.gitLabProject.deleteMany(),
      prisma.gitLabRestCacheEntry.deleteMany(),
      prisma.gitLabSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID },
        update: {
          currentUserId: null,
          currentUsername: null,
          currentUserName: null,
          currentUserAvatarUrl: null,
          currentUserWebUrl: null,
          version: null,
          revision: null,
          verifiedAt: null,
        },
      }),
    ]);
    return this.getSettings();
  }

  async projects(): Promise<GitLabProjectView[]> {
    const prisma = await getPrismaClient();
    return (
      await prisma.gitLabProject.findMany({
        orderBy: { pathWithNamespace: "asc" },
      })
    ).map(mapProject);
  }

  async projectForCanonicalOrigin(
    canonicalOrigin: string,
  ): Promise<GitLabProjectView | null> {
    const settings = await this.getSettings();
    if (!settings.configured || !settings.baseUrl) return null;
    const base = new URL(settings.baseUrl);
    const root = `${base.host}${base.pathname}`
      .replace(/\/+$/, "")
      .toLowerCase();
    const normalized = canonicalOrigin
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    return (
      (await this.projects()).find(
        (project) =>
          normalized ===
          `${root}/${project.pathWithNamespace}`
            .replace(/\/+/g, "/")
            .toLowerCase(),
      ) ?? null
    );
  }

  async mergeRequestForBranch(
    projectId: string,
    branch: string,
    force = false,
  ): Promise<GitLabMergeRequestView | null> {
    const response = await this.get<RawGitLabMergeRequest[]>({
      path: `/projects/${encodeURIComponent(projectId)}/merge_requests`,
      operation: "GitLabWorktreeMergeRequests",
      source: "WORKTREES",
      query: {
        state: "opened",
        source_branch: branch,
        order_by: "updated_at",
        sort: "desc",
        per_page: 1,
      },
      force,
      allowStaleOnError: !force,
    });
    return response.data[0] ? mapMergeRequest(response.data[0]) : null;
  }

  async availableProjects(
    search?: string | null,
    page = 1,
    perPage = 50,
  ): Promise<Paginated<GitLabProjectCandidateView>> {
    const size = Math.max(1, Math.min(MAX_PAGE_SIZE, perPage));
    const response = await this.get<RawGitLabProject[]>({
      path: "/projects",
      operation: "GitLabAvailableProjects",
      source: "GITLAB_SETTINGS",
      query: {
        membership: true,
        simple: true,
        order_by: "path",
        sort: "asc",
        search: search?.trim() || undefined,
        page,
        per_page: size,
      },
    });
    const prisma = await getPrismaClient();
    const managed = new Set(
      (await prisma.gitLabProject.findMany({ select: { id: true } })).map(
        (item) => item.id,
      ),
    );
    return {
      items: response.data.map((project) => ({
        id: String(project.id),
        name: project.name,
        pathWithNamespace: project.path_with_namespace,
        webUrl: project.web_url,
        defaultBranch: project.default_branch ?? null,
        visibility: project.visibility,
        alreadyManaged: managed.has(String(project.id)),
      })),
      total:
        positiveInt(response.headers.get("x-total")) ?? response.data.length,
      page,
      perPage: size,
      nextPage: pageValue(response.headers.get("x-next-page")),
    };
  }

  async addProject(projectId: string): Promise<GitLabProjectView[]> {
    const project = (
      await this.get<RawGitLabProject>({
        path: `/projects/${encodeURIComponent(projectId)}`,
        operation: "GitLabProject",
        source: "GITLAB_SETTINGS",
        force: true,
      })
    ).data;
    const prisma = await getPrismaClient();
    await prisma.gitLabProject.upsert({
      where: { id: String(project.id) },
      create: {
        id: String(project.id),
        name: project.name,
        pathWithNamespace: project.path_with_namespace,
        webUrl: project.web_url,
        defaultBranch: project.default_branch ?? null,
        visibility: project.visibility,
      },
      update: {
        name: project.name,
        pathWithNamespace: project.path_with_namespace,
        webUrl: project.web_url,
        defaultBranch: project.default_branch ?? null,
        visibility: project.visibility,
        enabled: true,
      },
    });
    return this.projects();
  }

  private async webhookSecrets(): Promise<WebhookSecrets> {
    const value = await this.credentials.getJson<unknown>(
      CREDENTIALS.gitlabWebhookSigningSecrets,
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  private signingToken(): string {
    return `whsec_${randomBytes(32).toString("base64")}`;
  }

  private normalizeWebhookUrl(value: string): string {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "GitLab webhook URL must be a public HTTPS URL without credentials, query, or fragment",
      );
    }
    return url.toString();
  }

  async configureProjectWebhook(
    projectId: string,
    callbackUrl: string,
  ): Promise<GitLabWebhookSetupView> {
    await this.credentials.assertWritable();
    const url = this.normalizeWebhookUrl(callbackUrl);
    const secrets = await this.webhookSecrets();
    const signingToken = secrets[projectId] ?? this.signingToken();
    const prisma = await getPrismaClient();
    const project = await prisma.gitLabProject.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new Error("The GitLab project is not managed by AIDE");
    let hookId = project.webhookId;
    let manual = false;
    let errorMessage: string | null = null;
    try {
      const body = {
        url,
        name: "AIDE",
        description: "AIDE merge request and pipeline events",
        signing_token: signingToken,
        ...WEBHOOK_EVENTS,
      };
      if (hookId) {
        await this.mutate({
          method: "PUT",
          path: `/projects/${encodeURIComponent(projectId)}/hooks/${encodeURIComponent(hookId)}`,
          operation: "GitLabUpdateProjectWebhook",
          source: "WEBHOOK_MANAGEMENT",
          body,
          invalidateProjectId: projectId,
        });
      } else {
        const hook = await this.mutate<{ id: number }>({
          method: "POST",
          path: `/projects/${encodeURIComponent(projectId)}/hooks`,
          operation: "GitLabCreateProjectWebhook",
          source: "WEBHOOK_MANAGEMENT",
          body,
          invalidateProjectId: projectId,
        });
        hookId = String(hook.id);
      }
    } catch (error) {
      if (
        error instanceof GitLabRequestError &&
        [401, 403, 404].includes(error.statusCode ?? 0)
      ) {
        manual = true;
        hookId = null;
        errorMessage =
          "Automatic setup requires the Maintainer or Owner role. Configure this project webhook manually.";
      } else {
        throw error;
      }
    }
    await this.credentials.setJson(
      CREDENTIALS.gitlabWebhookSigningSecrets,
      { ...secrets, [projectId]: signingToken },
      async (transaction) => {
        await transaction.gitLabProject.update({
          where: { id: projectId },
          data: {
            webhookId: hookId,
            webhookState: manual ? "MANUAL_REQUIRED" : "CONFIGURED",
            webhookError: errorMessage,
            webhookConfiguredAt: manual ? null : new Date(),
          },
        });
      },
    );
    const updated = await prisma.gitLabProject.findUniqueOrThrow({
      where: { id: projectId },
    });
    return {
      project: mapProject(updated),
      callbackUrl: url,
      signingToken: manual ? signingToken : null,
      manualConfigurationRequired: manual,
    };
  }

  async removeProjectWebhook(projectId: string): Promise<GitLabProjectView> {
    const prisma = await getPrismaClient();
    const project = await prisma.gitLabProject.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new Error("The GitLab project is not managed by AIDE");
    if (project.webhookId) {
      await this.mutate({
        method: "DELETE",
        path: `/projects/${encodeURIComponent(projectId)}/hooks/${encodeURIComponent(project.webhookId)}`,
        operation: "GitLabDeleteProjectWebhook",
        source: "WEBHOOK_MANAGEMENT",
        invalidateProjectId: projectId,
      });
    }
    const secrets = await this.webhookSecrets();
    delete secrets[projectId];
    await this.credentials.setJson(
      CREDENTIALS.gitlabWebhookSigningSecrets,
      secrets,
      async (transaction) => {
        await transaction.gitLabProject.update({
          where: { id: projectId },
          data: {
            webhookId: null,
            webhookState: "NOT_CONFIGURED",
            webhookError: null,
            webhookConfiguredAt: null,
          },
        });
      },
    );
    return mapProject(
      await prisma.gitLabProject.findUniqueOrThrow({
        where: { id: projectId },
      }),
    );
  }

  async removeProject(
    projectId: string,
    force = false,
  ): Promise<GitLabProjectView[]> {
    const prisma = await getPrismaClient();
    const project = await prisma.gitLabProject.findUnique({
      where: { id: projectId },
    });
    if (!project) return this.projects();
    if (project.webhookId) {
      try {
        await this.removeProjectWebhook(projectId);
      } catch (error) {
        if (!force) throw error;
      }
    }
    const secrets = await this.webhookSecrets();
    delete secrets[projectId];
    await this.credentials.setJson(
      CREDENTIALS.gitlabWebhookSigningSecrets,
      secrets,
      async (transaction) => {
        await transaction.gitLabProject.delete({ where: { id: projectId } });
      },
    );
    await this.invalidateCache(projectId);
    return this.projects();
  }

  async webhooksEnabled(): Promise<boolean> {
    const prisma = await getPrismaClient();
    return (
      (await prisma.gitLabProject.count({
        where: { webhookState: { in: ["CONFIGURED", "MANUAL_REQUIRED"] } },
      })) > 0
    );
  }

  async mergeRequests(input: {
    scope: GitLabMergeRequestScope;
    projectId?: string | null;
    state?: GitLabMergeRequestState | null;
    page?: number;
    perPage?: number;
  }): Promise<Paginated<GitLabMergeRequestView>> {
    const page = Math.max(1, input.page ?? 1);
    const perPage = Math.max(1, Math.min(MAX_PAGE_SIZE, input.perPage ?? 25));
    if (input.scope === "PROJECT" && !input.projectId) {
      throw new Error(
        "A project is required for project-scoped merge requests",
      );
    }
    const path = input.projectId
      ? `/projects/${encodeURIComponent(input.projectId)}/merge_requests`
      : "/merge_requests";
    const scope =
      input.scope === "MINE"
        ? "created_by_me"
        : input.scope === "REVIEW_REQUESTED"
          ? "reviews_for_me"
          : "all";
    const response = await this.get<RawGitLabMergeRequest[]>({
      path,
      operation: "GitLabMergeRequests",
      source: "MERGE_REQUESTS_PAGE",
      query: {
        scope,
        state:
          input.state && input.state !== "ALL"
            ? input.state.toLowerCase()
            : "all",
        order_by: "updated_at",
        sort: "desc",
        page,
        per_page: perPage,
      },
    });
    return {
      items: response.data.map(mapMergeRequest),
      total:
        positiveInt(response.headers.get("x-total")) ?? response.data.length,
      page,
      perPage,
      nextPage: pageValue(response.headers.get("x-next-page")),
    };
  }

  async mergeRequest(
    projectId: string,
    iid: number,
  ): Promise<GitLabMergeRequestDetailView> {
    const prefix = `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}`;
    const [mr, commits, discussions, pipelines] = await Promise.all([
      this.get<RawGitLabMergeRequest>({
        path: prefix,
        operation: "GitLabMergeRequest",
        source: "MERGE_REQUEST_DETAILS",
        query: { include_rebase_in_progress: true },
      }),
      this.get<unknown[]>({
        path: `${prefix}/commits`,
        operation: "GitLabMergeRequestCommits",
        source: "MERGE_REQUEST_DETAILS",
        query: { per_page: 100 },
      }),
      this.get<RawGitLabDiscussion[]>({
        path: `${prefix}/discussions`,
        operation: "GitLabMergeRequestDiscussions",
        source: "MERGE_REQUEST_DETAILS",
        query: { per_page: 100 },
      }),
      this.get<RawGitLabPipeline[]>({
        path: `${prefix}/pipelines`,
        operation: "GitLabMergeRequestPipelines",
        source: "MERGE_REQUEST_DETAILS",
        query: { per_page: 100 },
      }),
    ]);
    return {
      ...mapMergeRequest(mr.data),
      changesCount: mr.data.changes_count ?? null,
      commitsCount: commits.data.length,
      discussions: discussions.data.map(mapGitLabDiscussion),
      pipelines: pipelines.data.map(mapPipeline),
    };
  }

  async createMergeRequest(input: {
    projectId: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string | null;
    reviewerIds?: string[] | null;
    labels?: string[] | null;
    removeSourceBranch?: boolean | null;
    squash?: boolean | null;
  }): Promise<GitLabMergeRequestView> {
    const data = await this.mutate<RawGitLabMergeRequest>({
      method: "POST",
      path: `/projects/${encodeURIComponent(input.projectId)}/merge_requests`,
      operation: "GitLabCreateMergeRequest",
      source: "MERGE_REQUESTS_PAGE",
      body: {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description ?? undefined,
        reviewer_ids: input.reviewerIds?.map(Number),
        labels: input.labels?.join(","),
        remove_source_branch: input.removeSourceBranch ?? undefined,
        squash: input.squash ?? undefined,
      },
      invalidateProjectId: input.projectId,
    });
    return mapMergeRequest(data);
  }

  async updateMergeRequest(input: {
    projectId: string;
    iid: number;
    title?: string | null;
    description?: string | null;
    stateEvent?: "CLOSE" | "REOPEN" | null;
    reviewerIds?: string[] | null;
    labels?: string[] | null;
  }): Promise<GitLabMergeRequestView> {
    const data = await this.mutate<RawGitLabMergeRequest>({
      method: "PUT",
      path: `/projects/${encodeURIComponent(input.projectId)}/merge_requests/${input.iid}`,
      operation: "GitLabUpdateMergeRequest",
      source: "MERGE_REQUEST_DETAILS",
      body: {
        title: input.title ?? undefined,
        description: input.description ?? undefined,
        state_event: input.stateEvent?.toLowerCase(),
        reviewer_ids: input.reviewerIds?.map(Number),
        labels: input.labels?.join(","),
      },
      invalidateProjectId: input.projectId,
    });
    return mapMergeRequest(data);
  }

  async submitReview(input: {
    projectId: string;
    iid: number;
    outcome: GitLabReviewOutcome;
    body?: string | null;
  }): Promise<boolean> {
    const action =
      input.outcome === "APPROVE"
        ? "approve"
        : input.outcome === "REQUEST_CHANGES"
          ? "requested_changes"
          : "reviewed";
    await this.mutate({
      method: "POST",
      path: `/projects/${encodeURIComponent(input.projectId)}/merge_requests/${input.iid}/notes`,
      operation: "GitLabSubmitReview",
      source: "MERGE_REQUEST_DETAILS",
      body: {
        body: [input.body?.trim(), `/submit_review ${action}`]
          .filter(Boolean)
          .join("\n\n"),
      },
      invalidateProjectId: input.projectId,
    });
    return true;
  }

  async replyToDiscussion(input: {
    projectId: string;
    iid: number;
    discussionId: string;
    body: string;
  }): Promise<GitLabDiscussionView> {
    await this.mutate({
      method: "POST",
      path: `/projects/${encodeURIComponent(input.projectId)}/merge_requests/${input.iid}/discussions/${encodeURIComponent(input.discussionId)}/notes`,
      operation: "GitLabReplyToDiscussion",
      source: "COMMENTS_PAGE",
      body: { body: input.body },
      invalidateProjectId: input.projectId,
    });
    const discussion = await this.get<RawGitLabDiscussion>({
      path: `/projects/${encodeURIComponent(input.projectId)}/merge_requests/${input.iid}/discussions/${encodeURIComponent(input.discussionId)}`,
      operation: "GitLabDiscussion",
      source: "COMMENTS_PAGE",
      force: true,
    });
    return mapGitLabDiscussion(discussion.data);
  }

  async setDiscussionResolved(input: {
    projectId: string;
    iid: number;
    discussionId: string;
    resolved: boolean;
  }): Promise<GitLabDiscussionView> {
    const data = await this.mutate<RawGitLabDiscussion>({
      method: "PUT",
      path: `/projects/${encodeURIComponent(input.projectId)}/merge_requests/${input.iid}/discussions/${encodeURIComponent(input.discussionId)}`,
      operation: "GitLabResolveDiscussion",
      source: "COMMENTS_PAGE",
      body: { resolved: input.resolved },
      invalidateProjectId: input.projectId,
    });
    return mapGitLabDiscussion(data);
  }

  async mergeMergeRequest(input: {
    projectId: string;
    iid: number;
    squash?: boolean | null;
    removeSourceBranch?: boolean | null;
    autoMerge?: boolean | null;
    sha?: string | null;
  }): Promise<GitLabMergeRequestView> {
    const data = await this.mutate<RawGitLabMergeRequest>({
      method: "PUT",
      path: `/projects/${encodeURIComponent(input.projectId)}/merge_requests/${input.iid}/merge`,
      operation: "GitLabMergeMergeRequest",
      source: "MERGE_REQUEST_DETAILS",
      body: {
        squash: input.squash ?? undefined,
        should_remove_source_branch: input.removeSourceBranch ?? undefined,
        auto_merge: input.autoMerge ?? undefined,
        sha: input.sha ?? undefined,
      },
      invalidateProjectId: input.projectId,
    });
    return mapMergeRequest(data);
  }

  private async pipelineMergeRequests(
    projectId: string,
    sha: string,
  ): Promise<GitLabPipelineMergeRequestView[]> {
    try {
      const response = await this.get<RawGitLabMergeRequest[]>({
        path: `/projects/${encodeURIComponent(projectId)}/repository/commits/${encodeURIComponent(sha)}/merge_requests`,
        operation: "GitLabPipelineMergeRequests",
        source: "PIPELINES_PAGE",
        query: { per_page: 100 },
      });
      return response.data.map((mergeRequest) => ({
        projectId: String(mergeRequest.project_id),
        iid: mergeRequest.iid,
        title: mergeRequest.title,
        webUrl: mergeRequest.web_url,
        sourceBranch: mergeRequest.source_branch,
      }));
    } catch {
      // Commit association is supplementary; keep the pipeline visible when
      // the endpoint is unavailable or the token cannot read the repository.
      return [];
    }
  }

  private async pipelineWorktrees(
    projectId: string,
    branches: string[],
  ): Promise<Map<string, { id: string; highlightColor: string | null }>> {
    const links = new Map<
      string,
      { id: string; highlightColor: string | null }
    >();
    const names = [...new Set(branches.filter(Boolean))];
    if (!names.length) return links;
    const prisma = await getPrismaClient();
    const project = await prisma.gitLabProject.findUnique({
      where: { id: projectId },
      select: { webUrl: true },
    });
    if (!project) return links;
    const canonicalOrigin = normalizeGitOrigin(project.webUrl).canonicalOrigin;
    const repository = await prisma.codebaseRepository.findUnique({
      where: { canonicalOrigin },
      select: { id: true },
    });
    if (!repository) return links;
    const worktrees = await prisma.worktree.findMany({
      where: {
        missingAt: null,
        branch: { in: names },
        codebase: { repositoryId: repository.id },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, branch: true, highlightColor: true },
    });
    for (const worktree of worktrees) {
      if (!worktree.branch || links.has(worktree.branch)) continue;
      links.set(worktree.branch, {
        id: worktree.id,
        highlightColor: worktree.highlightColor,
      });
    }
    return links;
  }

  private async enrichPipelines(
    projectId: string,
    pipelines: GitLabPipelineView[],
  ): Promise<GitLabPipelineView[]> {
    if (!pipelines.length) return pipelines;
    const mergeRequestsBySha = new Map(
      await Promise.all(
        [...new Set(pipelines.map((pipeline) => pipeline.sha))].map(
          async (sha) =>
            [sha, await this.pipelineMergeRequests(projectId, sha)] as const,
        ),
      ),
    );
    const branches = pipelines.map((pipeline) =>
      resolveGitLabPipelineBranch(
        pipeline,
        mergeRequestsBySha.get(pipeline.sha) ?? [],
      ),
    );
    const worktrees = await this.pipelineWorktrees(projectId, branches);
    return pipelines.map((pipeline, index) => {
      const branch = branches[index] ?? pipeline.ref;
      const worktree = worktrees.get(branch);
      return {
        ...pipeline,
        branch,
        mergeRequests: mergeRequestsBySha.get(pipeline.sha) ?? [],
        worktreeId: worktree?.id ?? null,
        worktreeHighlightColor: worktree?.highlightColor ?? null,
      };
    });
  }

  private async observePipelines(
    pipelines: GitLabPipelineView[],
  ): Promise<void> {
    if (!pipelines.length) return;
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      for (const pipeline of pipelines) {
        const snapshot = await transaction.gitLabPipelineSnapshot.upsert({
          where: {
            projectId_headSha: {
              projectId: pipeline.projectId,
              headSha: pipeline.sha,
            },
          },
          create: {
            id: randomUUID(),
            projectId: pipeline.projectId,
            headSha: pipeline.sha,
            status: pipeline.status,
            lastObservedAt: new Date(),
          },
          update: { status: pipeline.status, lastObservedAt: new Date() },
        });
        await transaction.gitLabPipelineRecord.upsert({
          where: {
            snapshotId_pipelineId: {
              snapshotId: snapshot.id,
              pipelineId: pipeline.id,
            },
          },
          create: {
            id: randomUUID(),
            snapshotId: snapshot.id,
            pipelineId: pipeline.id,
            ref: pipeline.ref,
            status: pipeline.status,
            webUrl: pipeline.webUrl,
            source: pipeline.source,
            gitlabUpdatedAt: pipeline.updatedAt
              ? new Date(pipeline.updatedAt)
              : null,
            lastObservedAt: new Date(),
          },
          update: {
            ref: pipeline.ref,
            status: pipeline.status,
            webUrl: pipeline.webUrl,
            source: pipeline.source,
            gitlabUpdatedAt: pipeline.updatedAt
              ? new Date(pipeline.updatedAt)
              : null,
            lastObservedAt: new Date(),
          },
        });
      }
    });
  }

  async pipelines(
    projectId: string,
    page = 1,
    perPage = 25,
  ): Promise<Paginated<GitLabPipelineView>> {
    const size = Math.max(1, Math.min(MAX_PAGE_SIZE, perPage));
    const response = await this.get<RawGitLabPipeline[]>({
      path: `/projects/${encodeURIComponent(projectId)}/pipelines`,
      operation: "GitLabPipelines",
      source: "PIPELINES_PAGE",
      query: { page, per_page: size, order_by: "id", sort: "desc" },
    });
    const items = await this.enrichPipelines(
      projectId,
      response.data.map(mapPipeline),
    );
    await this.observePipelines(items);
    return {
      items,
      total:
        positiveInt(response.headers.get("x-total")) ?? response.data.length,
      page,
      perPage: size,
      nextPage: pageValue(response.headers.get("x-next-page")),
    };
  }

  async pipelinesForCommit(
    projectId: string,
    headSha: string,
  ): Promise<GitLabPipelineView[]> {
    const response = await this.get<RawGitLabPipeline[]>({
      path: `/projects/${encodeURIComponent(projectId)}/pipelines`,
      operation: "GitLabWorktreePipelines",
      source: "WORKTREES",
      query: {
        sha: headSha,
        per_page: MAX_PAGE_SIZE,
        order_by: "id",
        sort: "desc",
      },
      allowStaleOnError: true,
    });
    const pipelines = await this.enrichPipelines(
      projectId,
      response.data.map(mapPipeline),
    );
    await this.observePipelines(pipelines);
    return pipelines;
  }

  async pipeline(
    projectId: string,
    pipelineId: string,
  ): Promise<GitLabPipelineView> {
    const pipeline = mapPipeline(
      (
        await this.get<RawGitLabPipeline>({
          path: `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(pipelineId)}`,
          operation: "GitLabPipeline",
          source: "PIPELINES_PAGE",
        })
      ).data,
    );
    await this.observePipelines([pipeline]);
    return (await this.enrichPipelines(projectId, [pipeline]))[0] ?? pipeline;
  }

  async pipelineJobs(
    projectId: string,
    pipelineId: string,
  ): Promise<GitLabJobView[]> {
    const response = await this.get<RawGitLabJob[]>({
      path: `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/jobs`,
      operation: "GitLabPipelineJobs",
      source: "PIPELINES_PAGE",
      query: { include_retried: true, per_page: 100 },
    });
    const jobs = response.data.map(mapJob);
    const prisma = await getPrismaClient();
    await prisma.gitLabPipelineRecord.updateMany({
      where: { pipelineId },
      data: { jobsJson: JSON.stringify(jobs), lastObservedAt: new Date() },
    });
    return jobs;
  }

  async createPipeline(
    projectId: string,
    ref: string,
    variables: Array<{ key: string; value: string }> = [],
  ): Promise<GitLabPipelineView> {
    const pipeline = mapPipeline(
      await this.mutate<RawGitLabPipeline>({
        method: "POST",
        path: `/projects/${encodeURIComponent(projectId)}/pipeline`,
        operation: "GitLabCreatePipeline",
        source: "PIPELINES_PAGE",
        body: {
          ref,
          variables: variables.map((item) => ({
            ...item,
            variable_type: "env_var",
          })),
        },
        invalidateProjectId: projectId,
      }),
    );
    await this.observePipelines([pipeline]);
    this.publishPipeline(pipeline);
    return pipeline;
  }

  async retryPipeline(
    projectId: string,
    pipelineId: string,
  ): Promise<GitLabPipelineView> {
    const pipeline = mapPipeline(
      await this.mutate<RawGitLabPipeline>({
        method: "POST",
        path: `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/retry`,
        operation: "GitLabRetryPipeline",
        source: "PIPELINES_PAGE",
        invalidateProjectId: projectId,
      }),
    );
    await this.observePipelines([pipeline]);
    this.publishPipeline(pipeline);
    return pipeline;
  }

  async cancelPipeline(
    projectId: string,
    pipelineId: string,
  ): Promise<GitLabPipelineView> {
    const pipeline = mapPipeline(
      await this.mutate<RawGitLabPipeline>({
        method: "POST",
        path: `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/cancel`,
        operation: "GitLabCancelPipeline",
        source: "PIPELINES_PAGE",
        invalidateProjectId: projectId,
      }),
    );
    await this.observePipelines([pipeline]);
    this.publishPipeline(pipeline);
    return pipeline;
  }

  async retryJob(projectId: string, jobId: string): Promise<GitLabJobView> {
    return mapJob(
      await this.mutate<RawGitLabJob>({
        method: "POST",
        path: `/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/retry`,
        operation: "GitLabRetryJob",
        source: "PIPELINES_PAGE",
        invalidateProjectId: projectId,
      }),
    );
  }

  async cachedEntries(
    limit = 50,
    offset = 0,
  ): Promise<{
    items: GitLabCacheEntryView[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const prisma = await getPrismaClient();
    const [rows, total] = await Promise.all([
      prisma.gitLabRestCacheEntry.findMany({
        orderBy: { fetchedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.gitLabRestCacheEntry.count(),
    ]);
    const now = Date.now();
    const items = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        operation: row.operation,
        endpoint: row.endpoint,
        fetchedAt: row.fetchedAt.toISOString(),
        stale:
          now - row.fetchedAt.getTime() >=
          (await this.ttl(row.operation)) * 1000,
      })),
    );
    return { items, total, limit, offset };
  }

  async cacheMetrics(): Promise<{
    entries: number;
    calls: number;
    liveCalls: number;
    cacheHits: number;
    errors: number;
    staleFallbacks: number;
    averageDurationMs: number;
  }> {
    const prisma = await getPrismaClient();
    const [entries, calls] = await Promise.all([
      prisma.gitLabRestCacheEntry.count(),
      prisma.gitLabApiCallLog.findMany({
        select: { source: true, servedStale: true, durationMs: true },
      }),
    ]);
    const duration = calls.reduce((sum, call) => sum + call.durationMs, 0);
    return {
      entries,
      calls: calls.length,
      liveCalls: calls.filter(({ source }) => source === "LIVE").length,
      cacheHits: calls.filter(({ source }) => source === "CACHE").length,
      errors: calls.filter(({ source }) => source === "ERROR").length,
      staleFallbacks: calls.filter(({ servedStale }) => servedStale).length,
      averageDurationMs: calls.length ? duration / calls.length : 0,
    };
  }

  async cachedEntry(id: string): Promise<GitLabCacheEntryDetailView | null> {
    const prisma = await getPrismaClient();
    const row = await prisma.gitLabRestCacheEntry.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: row.id,
      operation: row.operation,
      endpoint: row.endpoint,
      fetchedAt: row.fetchedAt.toISOString(),
      stale:
        Date.now() - row.fetchedAt.getTime() >=
        (await this.ttl(row.operation)) * 1000,
      request: json(row.requestJson),
      response: json(row.responseJson),
    };
  }

  async clearCache(): Promise<boolean> {
    await this.invalidateCache();
    return true;
  }

  async deleteCachedEntry(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    return (
      (await prisma.gitLabRestCacheEntry.deleteMany({ where: { id } })).count >
      0
    );
  }

  async updateCacheTtl(ttlMinutes: number): Promise<GitLabSettingsView> {
    const ttlSeconds = ttlMinutes * 60;
    if (
      !Number.isInteger(ttlMinutes) ||
      ttlSeconds < MIN_TTL_SECONDS ||
      ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new Error("GitLab cache TTL must be from 1 second to 24 hours");
    }
    const prisma = await getPrismaClient();
    await prisma.gitLabSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, cacheTtlSeconds: ttlSeconds },
      update: { cacheTtlSeconds: ttlSeconds },
    });
    return this.getSettings();
  }

  async apiCalls(
    limit = 50,
    offset = 0,
  ): Promise<{
    items: GitLabApiCallView[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const prisma = await getPrismaClient();
    const [rows, total] = await Promise.all([
      prisma.gitLabApiCallLog.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.gitLabApiCallLog.count(),
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        source: row.source as "LIVE" | "CACHE" | "ERROR",
        rateLimitResetAt: row.rateLimitResetAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      limit,
      offset,
    };
  }

  async webhookDeliveries(
    limit = 50,
    offset = 0,
  ): Promise<{
    items: GitLabWebhookDeliveryView[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const prisma = await getPrismaClient();
    const [rows, total] = await Promise.all([
      prisma.gitLabWebhookDelivery.findMany({
        orderBy: { receivedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.gitLabWebhookDelivery.count(),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        webhookId: row.webhookId,
        eventType: row.eventType,
        projectId: row.projectId,
        objectKind: row.objectKind,
        action: row.action,
        outcome: row.outcome,
        error: row.error,
        receivedAt: row.receivedAt.toISOString(),
        processedAt: row.processedAt?.toISOString() ?? null,
      })),
      total,
      limit,
      offset,
    };
  }

  async rateLimitSnapshots() {
    const prisma = await getPrismaClient();
    return (
      await prisma.gitLabRateLimitSnapshot.findMany({
        orderBy: { observedAt: "desc" },
      })
    ).map((row) => ({
      ...row,
      resetAt: row.resetAt?.toISOString() ?? null,
      observedAt: row.observedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async cacheTtlOverrides() {
    const prisma = await getPrismaClient();
    return (
      await prisma.gitLabRestCacheTtlOverride.findMany({
        orderBy: { operation: "asc" },
      })
    ).map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async saveCacheTtlOverride(operation: string, ttlSeconds: number) {
    const normalized = operation.trim();
    if (!normalized) throw new Error("GitLab cache operation is required");
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < MIN_TTL_SECONDS ||
      ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new Error("GitLab cache TTL must be from 1 second to 24 hours");
    }
    const prisma = await getPrismaClient();
    await prisma.gitLabRestCacheTtlOverride.upsert({
      where: { operation: normalized },
      create: { operation: normalized, ttlSeconds },
      update: { ttlSeconds },
    });
    return this.cacheTtlOverrides();
  }

  async deleteCacheTtlOverride(operation: string) {
    const prisma = await getPrismaClient();
    await prisma.gitLabRestCacheTtlOverride.deleteMany({
      where: { operation },
    });
    return this.cacheTtlOverrides();
  }

  async autoRetryRules(
    projectId?: string | null,
  ): Promise<GitLabAutoRetryRuleView[]> {
    const prisma = await getPrismaClient();
    const rules = await prisma.gitLabAutoRetryRule.findMany({
      where: projectId ? { projectId } : undefined,
      include: { executions: { orderBy: { createdAt: "desc" } } },
      orderBy: { updatedAt: "desc" },
    });
    return rules.map((rule) => ({
      ...rule,
      lastAttemptAt: rule.lastAttemptAt?.toISOString() ?? null,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
      executions: rule.executions.map((execution) => ({
        ...execution,
        createdAt: execution.createdAt.toISOString(),
        updatedAt: execution.updatedAt.toISOString(),
      })),
    }));
  }

  async saveAutoRetryRule(input: {
    id?: string | null;
    projectId: string;
    pipelineId?: string | null;
    enabled?: boolean | null;
    maxAttempts: number;
  }): Promise<GitLabAutoRetryRuleView> {
    if (
      !Number.isInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 100
    ) {
      throw new Error("GitLab auto-retry attempts must be from 1 to 100");
    }
    const project = await (
      await getPrismaClient()
    ).gitLabProject.findUnique({
      where: { id: input.projectId },
    });
    if (!project?.enabled)
      throw new Error("A managed GitLab project is required");
    const prisma = await getPrismaClient();
    const id = input.id ?? randomUUID();
    await prisma.gitLabAutoRetryRule.upsert({
      where: { id },
      create: {
        id,
        projectId: input.projectId,
        pipelineId: input.pipelineId ?? null,
        enabled: input.enabled ?? true,
        maxAttempts: input.maxAttempts,
      },
      update: {
        projectId: input.projectId,
        pipelineId: input.pipelineId ?? null,
        enabled: input.enabled ?? true,
        maxAttempts: input.maxAttempts,
      },
    });
    queueMicrotask(() => void this.reconcileAutoRetries());
    return (await this.autoRetryRules()).find((rule) => rule.id === id)!;
  }

  async deleteAutoRetryRule(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    return (
      (await prisma.gitLabAutoRetryRule.deleteMany({ where: { id } })).count > 0
    );
  }

  private async autoRetryFailedPipeline(
    projectId: string,
    pipelineId: string,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    const rules = await prisma.gitLabAutoRetryRule.findMany({
      where: {
        projectId,
        enabled: true,
        OR: [{ pipelineId: null }, { pipelineId }],
      },
    });
    for (const rule of rules) {
      const attempts = await prisma.gitLabAutoRetryExecution.count({
        where: { ruleId: rule.id, pipelineId },
      });
      if (attempts >= rule.maxAttempts) continue;
      const attempt = attempts + 1;
      let execution;
      try {
        execution = await prisma.gitLabAutoRetryExecution.create({
          data: {
            id: randomUUID(),
            ruleId: rule.id,
            pipelineId,
            attempt,
            status: "RUNNING",
          },
        });
      } catch {
        continue;
      }
      try {
        await this.retryPipeline(projectId, pipelineId);
        await prisma.$transaction([
          prisma.gitLabAutoRetryExecution.update({
            where: { id: execution.id },
            data: { status: "RETRIED" },
          }),
          prisma.gitLabAutoRetryRule.update({
            where: { id: rule.id },
            data: {
              attempts: { increment: 1 },
              lastAttemptAt: new Date(),
              lastError: null,
            },
          }),
        ]);
      } catch (error) {
        const message = sanitizedError(error);
        await prisma.$transaction([
          prisma.gitLabAutoRetryExecution.update({
            where: { id: execution.id },
            data: { status: "FAILED", lastError: message },
          }),
          prisma.gitLabAutoRetryRule.update({
            where: { id: rule.id },
            data: { lastAttemptAt: new Date(), lastError: message },
          }),
        ]);
      }
    }
  }

  async reconcileAutoRetries(): Promise<number> {
    const prisma = await getPrismaClient();
    const rules = await prisma.gitLabAutoRetryRule.findMany({
      where: { enabled: true },
      select: { projectId: true },
      distinct: ["projectId"],
    });
    for (const { projectId } of rules) {
      const page = await this.pipelines(projectId, 1, 100);
      for (const pipeline of page.items) {
        if (["FAILED", "CANCELED"].includes(pipeline.status)) {
          await this.autoRetryFailedPipeline(projectId, pipeline.id);
        }
      }
    }
    return rules.length;
  }

  private async recordWebhookWorkflowEvents(input: {
    messageId: string;
    eventType: string;
    projectId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.workflowEvents) return;
    const value = (key: string) => {
      const candidate = input.payload[key];
      return candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : {};
    };
    const project = value("project");
    const attributes = value("object_attributes");
    const user = value("user");
    const kind = String(input.payload.object_kind ?? "").toLowerCase();
    const status = String(attributes.status ?? "").toLowerCase();
    const action = String(attributes.action ?? "").toLowerCase();
    const sessionData: Record<string, unknown> = {
      repo: {
        provider: "GITLAB",
        gitlabProjectId: input.projectId,
        name: project.name ?? null,
        pathWithNamespace: project.path_with_namespace ?? null,
        webUrl: project.web_url ?? null,
      },
      actor: {
        id: user.id ?? null,
        username: user.username ?? null,
        name: user.name ?? null,
      },
    };
    if (kind === "merge_request") {
      sessionData.pr = {
        provider: "GITLAB",
        id: attributes.id ?? null,
        iid: attributes.iid ?? null,
        number: attributes.iid ?? null,
        title: attributes.title ?? null,
        description: attributes.description ?? null,
        state: attributes.state ?? null,
        action: attributes.action ?? null,
        isDraft: attributes.draft ?? false,
        headRefName: attributes.source_branch ?? null,
        headRefOid:
          attributes.last_commit && typeof attributes.last_commit === "object"
            ? ((attributes.last_commit as Record<string, unknown>).id ?? null)
            : null,
        targetBranch: attributes.target_branch ?? null,
        url: attributes.url ?? null,
        labels: attributes.labels ?? [],
      };
    } else if (kind === "pipeline") {
      sessionData.pipeline = {
        id: attributes.id ?? null,
        status: attributes.status ?? null,
        ref: attributes.ref ?? null,
        sha: attributes.sha ?? null,
        source: attributes.source ?? null,
      };
    } else if (kind === "build") {
      sessionData.job = {
        id: input.payload.build_id ?? null,
        name: input.payload.build_name ?? null,
        stage: input.payload.build_stage ?? null,
        status: input.payload.build_status ?? null,
      };
      sessionData.pipeline = { id: value("pipeline").id ?? null };
    } else if (kind === "note") {
      const mergeRequest = value("merge_request");
      sessionData.pr = {
        provider: "GITLAB",
        id: mergeRequest.id ?? null,
        iid: mergeRequest.iid ?? null,
        number: mergeRequest.iid ?? null,
        title: mergeRequest.title ?? null,
        state: mergeRequest.state ?? null,
        headRefName: mergeRequest.source_branch ?? null,
        targetBranch: mergeRequest.target_branch ?? null,
        url: mergeRequest.url ?? null,
      };
      sessionData.comment = {
        id: attributes.id ?? null,
        body: attributes.note ?? null,
        url: attributes.url ?? null,
        author: {
          id: user.id ?? null,
          username: user.username ?? null,
          name: user.name ?? null,
        },
      };
    } else if (kind === "push") {
      sessionData.push = {
        ref: input.payload.ref ?? null,
        before: input.payload.before ?? null,
        after: input.payload.after ?? null,
        commits: input.payload.commits ?? [],
      };
    }

    const triggerKinds: string[] = [];
    if (kind === "merge_request") {
      if (["open", "reopen", "update"].includes(action))
        triggerKinds.push("GITLAB_MR_STATE");
      if (["close", "merge"].includes(action))
        triggerKinds.push("GITLAB_MR_CLOSED");
      if (action === "update") triggerKinds.push("GITLAB_MR_SYNCHRONIZED");
      if (action === "approved" || action === "approval")
        triggerKinds.push("GITLAB_REVIEW_APPROVED");
      if (action.includes("label")) triggerKinds.push("GITLAB_MR_LABEL");
    } else if (kind === "note") {
      triggerKinds.push("GITLAB_REVIEW_COMMENT", "GITLAB_NOTE_COMMAND");
      const body = String(attributes.note ?? "");
      if (body.includes("/submit_review requested_changes")) {
        triggerKinds.push("GITLAB_REVIEW_CHANGES_REQUESTED");
      }
      if (body.includes("/submit_review approve")) {
        triggerKinds.push("GITLAB_REVIEW_APPROVED");
      }
    } else if (kind === "pipeline") {
      triggerKinds.push("GITLAB_PIPELINE_STATUS_CHANGED");
      if (["success", "failed", "canceled", "skipped"].includes(status)) {
        triggerKinds.push("GITLAB_PIPELINE_RESULT");
      }
      if (status === "failed") triggerKinds.push("GITLAB_PIPELINE_FAILED");
      if (status === "success") triggerKinds.push("GITLAB_PIPELINE_SUCCEEDED");
    } else if (kind === "build") {
      triggerKinds.push("GITLAB_JOB_STATUS_CHANGED");
    } else if (kind === "push") {
      const defaultBranch = String(project.default_branch ?? "");
      const ref = String(input.payload.ref ?? "");
      if (defaultBranch && ref === `refs/heads/${defaultBranch}`) {
        triggerKinds.push("GITLAB_PUSH_DEFAULT");
      }
    }
    await Promise.all(
      [...new Set(triggerKinds)].map((triggerKind) =>
        this.workflowEvents!.record({
          kind: triggerKind,
          subjectKey: `${input.projectId}:${String(attributes.iid ?? attributes.id ?? input.messageId)}`,
          dedupeKey: `gitlab:${input.messageId}:${triggerKind}`,
          payload: { sessionData, providerEvent: input.payload },
        }),
      ),
    );
  }

  private async recordWebhookNotification(input: {
    messageId: string;
    projectId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.notifications) return;
    const attributes =
      input.payload.object_attributes &&
      typeof input.payload.object_attributes === "object"
        ? (input.payload.object_attributes as Record<string, unknown>)
        : {};
    const kind = String(input.payload.object_kind ?? "").toLowerCase();
    let typeKey:
      | "GITLAB_PIPELINE_SUCCEEDED"
      | "GITLAB_PIPELINE_FAILED"
      | "GITLAB_REVIEW_REQUESTED"
      | null = null;
    let href = "/gitlab/merge-requests";
    let title = "GitLab update";
    let body = "GitLab reported an update.";
    let resourceKind = "GITLAB_MERGE_REQUEST";
    let resourceId = `${input.projectId}:${String(attributes.iid ?? attributes.id ?? input.messageId)}`;
    if (kind === "pipeline") {
      const status = String(attributes.status ?? "").toLowerCase();
      if (status === "success") typeKey = "GITLAB_PIPELINE_SUCCEEDED";
      if (status === "failed") typeKey = "GITLAB_PIPELINE_FAILED";
      if (!typeKey) return;
      const pipelineId = String(attributes.id ?? "");
      href = `/gitlab/pipelines?project=${encodeURIComponent(input.projectId)}&pipeline=${encodeURIComponent(pipelineId)}`;
      title =
        status === "success"
          ? "GitLab pipeline succeeded"
          : "GitLab pipeline failed";
      body = `${String(attributes.ref ?? "Pipeline")} · #${pipelineId}`;
      resourceKind = "GITLAB_PIPELINE";
      resourceId = `${input.projectId}:${pipelineId}`;
    } else if (
      kind === "merge_request" &&
      ["open", "reopen", "approved"].includes(
        String(attributes.action ?? "").toLowerCase(),
      )
    ) {
      typeKey = "GITLAB_REVIEW_REQUESTED";
      const iid = String(attributes.iid ?? "");
      href = `/gitlab/merge-requests/${encodeURIComponent(input.projectId)}/${encodeURIComponent(iid)}`;
      title = "GitLab review requested";
      body = String(attributes.title ?? `Merge request !${iid}`);
    }
    if (!typeKey) return;
    const prisma = await getPrismaClient();
    const notification = await prisma.$transaction((transaction) =>
      this.notifications!.recordInTransaction(transaction, {
        dedupeKey: `gitlab:${input.messageId}:${typeKey}`,
        typeKey,
        title,
        body,
        href,
        resourceKind,
        resourceId,
      }),
    );
    this.notifications.created(notification);
  }

  async handleWebhook(input: {
    rawBody: string;
    headers: Headers;
  }): Promise<{ duplicate: boolean }> {
    const messageId = input.headers.get("webhook-id");
    const timestamp = input.headers.get("webhook-timestamp");
    const signature = input.headers.get("webhook-signature");
    const eventType = input.headers.get("x-gitlab-event") ?? "Unknown Hook";
    if (!messageId || !timestamp || !signature) {
      throw new Error("Missing GitLab Standard Webhook signature headers");
    }
    const seconds = Number(timestamp);
    if (
      !Number.isFinite(seconds) ||
      Math.abs(Date.now() / 1000 - seconds) > WEBHOOK_REPLAY_WINDOW_SECONDS
    ) {
      throw new Error("GitLab webhook timestamp is outside the replay window");
    }
    const payload = json(input.rawBody);
    if (!payload || typeof payload !== "object")
      throw new Error("Invalid GitLab webhook JSON");
    const source = payload as Record<string, unknown>;
    const projectId = gitLabWebhookProjectId(source);
    if (!projectId)
      throw new Error("GitLab webhook payload does not identify a project");
    const secrets = await this.webhookSecrets();
    const token = secrets[projectId];
    if (!token?.startsWith("whsec_"))
      throw new Error("No signing token is configured for this GitLab project");
    verifyGitLabWebhookSignature({
      rawBody: input.rawBody,
      webhookId: messageId,
      timestamp,
      signature,
      signingToken: token,
    });
    const prisma = await getPrismaClient();
    const existing = await prisma.gitLabWebhookDelivery.findUnique({
      where: { webhookId: messageId },
    });
    if (existing) return { duplicate: true };
    const objectAttributes = source.object_attributes;
    const action =
      objectAttributes &&
      typeof objectAttributes === "object" &&
      "action" in objectAttributes
        ? String((objectAttributes as { action: unknown }).action)
        : null;
    await prisma.$transaction([
      prisma.gitLabWebhookDelivery.create({
        data: {
          id: randomUUID(),
          webhookId: messageId,
          eventType,
          projectId,
          objectKind:
            typeof source.object_kind === "string" ? source.object_kind : null,
          action,
          outcome: "PROCESSED",
          payloadJson: input.rawBody.slice(0, 1_000_000),
          receivedAt: new Date(seconds * 1000),
          processedAt: new Date(),
        },
      }),
      prisma.gitLabProject.updateMany({
        where: { id: projectId },
        data: { webhookLastReceivedAt: new Date(), webhookError: null },
      }),
      prisma.gitLabRestCacheEntry.deleteMany({
        where: {
          endpoint: { contains: `/projects/${encodeURIComponent(projectId)}/` },
        },
      }),
    ]);
    await this.recordWebhookWorkflowEvents({
      messageId,
      eventType,
      projectId,
      payload: source,
    });
    await this.recordWebhookNotification({
      messageId,
      projectId,
      payload: source,
    });
    if (
      String(source.object_kind ?? "").toLowerCase() === "pipeline" &&
      ["failed", "canceled"].includes(
        String(
          source.object_attributes &&
            typeof source.object_attributes === "object" &&
            "status" in source.object_attributes
            ? (source.object_attributes as { status: unknown }).status
            : "",
        ).toLowerCase(),
      )
    ) {
      const attributes = source.object_attributes as Record<string, unknown>;
      if (attributes.id != null) {
        await this.autoRetryFailedPipeline(projectId, String(attributes.id));
      }
    }
    if (String(source.object_kind ?? "").toLowerCase() === "pipeline") {
      const attributes = source.object_attributes as Record<string, unknown>;
      if (attributes.id != null) {
        try {
          this.publishPipeline(
            await this.pipeline(projectId, String(attributes.id)),
          );
        } catch {
          // The durable webhook record remains authoritative if refresh fails.
        }
      }
    }
    return { duplicate: false };
  }
}
