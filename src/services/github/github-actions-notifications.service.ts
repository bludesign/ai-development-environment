import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { getPrismaClient } from "@/data/prisma-client";
import { CREDENTIALS, type CredentialService } from "@/services/credentials";
import type {
  NotificationRecord,
  NotificationsService,
} from "@/services/notifications";
import type { PollingService } from "@/services/polling";
import type { WorkflowEventsService } from "@/services/workflows/workflow-events.service";

import { GitHubCache } from "./github-cache";
import { GITHUB_API_BASE_URL } from "./github-endpoints";
import {
  observeGitHubRateLimit,
  type GitHubRateLimitMetadata,
} from "./github-rate-limit";
import { GITHUB_REST_OPERATIONS } from "./github-rest-operations";
import { GitHubPipelineStatusService } from "./github-pipeline-status.service";
import { normalizePipelineState } from "./pipeline-status";
import type { GitHubPipelineState, GitHubWorkflowJobView } from "./types";

const OPERATION_ID = "server:github-actions-notifications";
const DEFAULT_INTERVAL_SECONDS = 60;
const GITHUB_RUNS_PAGE_SIZE = 100;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "startup_failure",
  "action_required",
]);

type RepositoryTarget = {
  id: string;
  name: string;
  owner: string;
  repository: string;
  canonicalOrigin: string;
  displayOrigin: string;
  jiraBranchRegex: string | null;
};

type WorkflowRun = {
  id: string;
  workflowId: string;
  runAttempt: number;
  name: string;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  headBranch: string | null;
  headSha: string | null;
  pullRequests: Array<{ number: number; url: string | null }>;
  url: string;
  updatedAt: Date;
  repositoryGithubId: string | null;
  repositoryNameWithOwner: string;
  repositoryUrl: string;
  checkSuiteId: string | null;
};

type WebhookResult = {
  outcome: "DUPLICATE" | "IGNORED" | "PROCESSED";
  notificationCreated: boolean;
};

function secureEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function notificationType(conclusion: string | null) {
  if (conclusion === "success") return "GITHUB_ACTIONS_SUCCEEDED" as const;
  if (conclusion && FAILURE_CONCLUSIONS.has(conclusion)) {
    return "GITHUB_ACTIONS_FAILED" as const;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function workflowPullRequests(
  value: unknown,
): Array<{ number: number; url: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const number = positiveInteger(record.number);
    return number
      ? [{ number, url: text(record.html_url) ?? text(record.url) }]
      : [];
  });
}

function webhookWorkflowRun(
  target: RepositoryTarget,
  repository: Record<string, unknown> | undefined,
  workflow: Record<string, unknown> | undefined,
): WorkflowRun | null {
  const runId = positiveInteger(workflow?.id);
  const workflowId = positiveInteger(workflow?.workflow_id);
  const updatedAtValue = text(workflow?.updated_at);
  const updatedAt = updatedAtValue ? new Date(updatedAtValue) : null;
  if (
    !runId ||
    !workflowId ||
    !updatedAt ||
    !Number.isFinite(updatedAt.getTime())
  ) {
    return null;
  }
  return {
    id: String(runId),
    workflowId: String(workflowId),
    runAttempt: positiveInteger(workflow?.run_attempt) ?? 1,
    name: text(workflow?.name) ?? "GitHub Actions",
    displayTitle:
      text(workflow?.display_title) ?? text(workflow?.name) ?? "Workflow run",
    status: text(workflow?.status)?.toLowerCase() ?? "unknown",
    conclusion: text(workflow?.conclusion)?.toLowerCase() ?? null,
    headBranch: text(workflow?.head_branch),
    headSha: text(workflow?.head_sha),
    pullRequests: workflowPullRequests(workflow?.pull_requests),
    url: text(workflow?.html_url) ?? "",
    updatedAt,
    repositoryGithubId: text(repository?.node_id),
    repositoryNameWithOwner:
      text(repository?.full_name) ?? `${target.owner}/${target.repository}`,
    repositoryUrl:
      text(repository?.html_url) ??
      `https://github.com/${target.owner}/${target.repository}`,
    checkSuiteId: text(workflow?.check_suite_node_id),
  };
}

function childPipelineState(
  status: string | null,
  conclusion: string | null,
): GitHubPipelineState {
  const normalized = normalizePipelineState(status, conclusion);
  return normalized === "SUCCESS" ||
    normalized === "NEUTRAL" ||
    normalized === "SKIPPED"
    ? "IN_PROGRESS"
    : normalized;
}

function jiraKeyFromBranch(
  branch: string | null,
  pattern: string,
): string | null {
  if (!branch || !pattern) return null;
  try {
    const match = new RegExp(pattern, "i").exec(branch);
    const key = (match?.[1] ?? match?.[0])?.trim();
    return key ? key.toUpperCase() : null;
  } catch {
    return null;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export class GitHubActionsNotificationsService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerunRequested = false;

  constructor(
    private readonly credentials: CredentialService,
    private readonly notifications: NotificationsService,
    private readonly polling: PollingService,
    startPolling = true,
    private readonly workflowEvents?: WorkflowEventsService,
    private readonly cache = new GitHubCache(),
    private readonly pipelineStatus = new GitHubPipelineStatusService(),
  ) {
    this.polling.register({
      id: OPERATION_ID,
      kind: "GITHUB_ACTIONS_NOTIFICATIONS",
      runtime: "SERVER",
      enabled: false,
      cadenceSeconds: DEFAULT_INTERVAL_SECONDS,
      details: { mode: "DISABLED" },
    });
    if (startPolling) queueMicrotask(() => void this.tick());
  }

  private async recordWorkflowRunEvent(
    target: RepositoryTarget,
    run: WorkflowRun,
  ): Promise<void> {
    if (!this.workflowEvents || run.status !== "completed") return;
    const prisma = await getPrismaClient();
    const [worktree, codebaseSettings] = await Promise.all([
      run.headBranch
        ? prisma.worktree.findFirst({
            where: {
              branch: run.headBranch,
              missingAt: null,
              codebase: { repositoryId: target.id },
            },
            orderBy: { updatedAt: "desc" },
            select: {
              id: true,
              folder: true,
              branch: true,
              baseBranchOverride: true,
              headSha: true,
              codebase: {
                select: {
                  id: true,
                  folder: true,
                  agentId: true,
                  defaultBranch: true,
                  agent: {
                    select: { id: true, name: true, hostname: true },
                  },
                },
              },
            },
          })
        : null,
      prisma.codebaseSettings.findUnique({ where: { id: "default" } }),
    ]);
    const ticketKey = jiraKeyFromBranch(
      run.headBranch,
      target.jiraBranchRegex ?? codebaseSettings?.defaultJiraBranchRegex ?? "",
    );
    const primaryPullRequest = run.pullRequests[0] ?? null;
    const sessionData = {
      repo: {
        id: target.id,
        name: target.name,
        owner: target.owner,
        url: `https://github.com/${target.owner}/${target.repository}`,
        canonicalOrigin: target.canonicalOrigin,
        displayOrigin: target.displayOrigin,
        defaultBranch: worktree?.codebase.defaultBranch ?? null,
      },
      pipeline: {
        runId: run.id,
        workflowId: run.workflowId,
        name: run.name,
        displayTitle: run.displayTitle,
        status: run.status,
        conclusion: run.conclusion,
        headBranch: run.headBranch,
        headSha: run.headSha,
        pullRequests: run.pullRequests,
        url: run.url,
      },
      ...(worktree
        ? {
            worktree: {
              id: worktree.id,
              path: worktree.folder,
              branch: worktree.branch,
              baseBranch:
                worktree.baseBranchOverride ?? worktree.codebase.defaultBranch,
              headSha: worktree.headSha,
            },
            codebase: {
              id: worktree.codebase.id,
              folder: worktree.codebase.folder,
              agentId: worktree.codebase.agentId,
            },
            agent: worktree.codebase.agent,
          }
        : {}),
      ...(primaryPullRequest ? { pr: primaryPullRequest } : {}),
      ...(ticketKey ? { ticket: { key: ticketKey } } : {}),
    };
    const extras = {
      cursorValue: `${run.id}:${run.runAttempt}:${run.conclusion ?? "none"}`,
    };
    await this.workflowEvents.record({
      kind: "GITHUB_ACTIONS_RESULT",
      subjectKey: target.id,
      dedupeKey: `github-actions-trigger:${target.id}:${run.id}:${run.runAttempt}`,
      payload: { ...sessionData, ...extras, sessionData },
    });
    const secondary =
      run.conclusion === "success"
        ? "GITHUB_WORKFLOW_SUCCEEDED"
        : run.conclusion && FAILURE_CONCLUSIONS.has(run.conclusion)
          ? "GITHUB_CHECK_FAILED"
          : null;
    if (secondary) {
      await this.workflowEvents.record({
        kind: secondary,
        subjectKey: target.id,
        dedupeKey: `github-workflow-trigger:${secondary}:${target.id}:${run.id}:${run.runAttempt}`,
        payload: { ...sessionData, ...extras, sessionData },
      });
    }
  }

  private async observePipelineRun(
    target: RepositoryTarget,
    run: WorkflowRun,
    source: "REST" | "WEBHOOK",
    appConfigured = true,
  ): Promise<boolean> {
    if (!run.repositoryGithubId || !run.headSha) return false;
    const completed = run.status === "completed";
    const workflowRunAvailable = Boolean(run.checkSuiteId);
    await this.pipelineStatus.observeSnapshot({
      repositoryGithubId: run.repositoryGithubId,
      repositoryNameWithOwner: run.repositoryNameWithOwner,
      repositoryUrl: run.repositoryUrl,
      headSha: run.headSha,
      pipelines: [
        {
          id: run.id,
          name: run.name,
          status: normalizePipelineState(run.status, run.conclusion),
          url: run.url,
          checkSuiteId: run.checkSuiteId,
          workflowRunId: run.id,
          workflowId: run.workflowId,
          runAttempt: run.runAttempt,
          canRetry: completed && workflowRunAvailable && appConfigured,
          retryUnavailableReason: !completed
            ? "NOT_COMPLETED"
            : !workflowRunAvailable
              ? "WORKFLOW_RUN_UNAVAILABLE"
              : appConfigured
                ? null
                : "GITHUB_APP_NOT_CONFIGURED",
          source,
          githubUpdatedAt: run.updatedAt,
        },
      ],
    });
    return true;
  }

  private async observeEnhancedWebhook(
    target: RepositoryTarget,
    event: string,
    action: string | null,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const allowedActions: Partial<Record<string, Set<string | null>>> = {
      workflow_run: new Set(["requested", "in_progress", "completed"]),
      workflow_job: new Set(["queued", "in_progress", "completed"]),
      check_run: new Set(["created", "rerequested", "completed"]),
      check_suite: new Set([
        "requested",
        "rerequested",
        "in_progress",
        "completed",
      ]),
      status: new Set([null]),
    };
    if (!allowedActions[event]?.has(action)) return false;
    const repository = payload.repository as
      Record<string, unknown> | undefined;
    const repositoryGithubId = text(repository?.node_id);
    const headSha =
      event === "status"
        ? text(payload.sha)
        : text(((payload[event] ?? {}) as Record<string, unknown>).head_sha);
    if (!repositoryGithubId || !headSha) return false;
    const repositoryNameWithOwner =
      text(repository?.full_name) ?? `${target.owner}/${target.repository}`;
    const repositoryUrl =
      text(repository?.html_url) ??
      `https://github.com/${target.owner}/${target.repository}`;

    if (event === "workflow_run") {
      const run = webhookWorkflowRun(
        target,
        repository,
        payload.workflow_run as Record<string, unknown> | undefined,
      );
      return run ? this.observePipelineRun(target, run, "WEBHOOK") : false;
    }

    if (event === "status") {
      const context = text(payload.context);
      if (!context) return false;
      await this.pipelineStatus.observeSnapshot({
        repositoryGithubId,
        repositoryNameWithOwner,
        repositoryUrl,
        headSha,
        pipelines: [
          {
            id: context,
            name: context,
            status: normalizePipelineState(text(payload.state)),
            url: text(payload.target_url),
            statusContext: context,
            source: "WEBHOOK",
            githubUpdatedAt: (() => {
              const value =
                text(payload.updated_at) ?? text(payload.created_at);
              return value ? new Date(value) : null;
            })(),
          },
        ],
      });
      return true;
    }

    if (event === "check_suite") {
      const suite = payload.check_suite as Record<string, unknown> | undefined;
      const checkSuiteId = text(suite?.node_id);
      if (!suite || !checkSuiteId) return false;
      const app = suite.app as Record<string, unknown> | undefined;
      const updatedAtValue =
        text(suite.updated_at) ??
        text(suite.completed_at) ??
        text(suite.started_at);
      await this.pipelineStatus.observeSnapshot({
        repositoryGithubId,
        repositoryNameWithOwner,
        repositoryUrl,
        headSha,
        pipelines: [
          {
            id: checkSuiteId,
            name: text(app?.name) ?? "GitHub checks",
            status: normalizePipelineState(
              text(suite.status),
              text(suite.conclusion),
            ),
            url: text(suite.url),
            checkSuiteId,
            source: "WEBHOOK",
            githubUpdatedAt: updatedAtValue ? new Date(updatedAtValue) : null,
          },
        ],
      });
      return true;
    }

    if (event === "check_run") {
      const checkRun = payload.check_run as Record<string, unknown> | undefined;
      const suite = checkRun?.check_suite as
        Record<string, unknown> | undefined;
      const checkSuiteId = text(suite?.node_id);
      const checkRunId = text(checkRun?.node_id);
      if (!checkRun || !checkSuiteId || !checkRunId) return false;
      const updatedAtValue =
        text(checkRun.completed_at) ??
        text(checkRun.started_at) ??
        text(checkRun.updated_at);
      await this.pipelineStatus.observeSnapshot({
        repositoryGithubId,
        repositoryNameWithOwner,
        repositoryUrl,
        headSha,
        pipelines: [
          {
            id: checkRunId,
            name: text(checkRun.name) ?? "GitHub check",
            status: childPipelineState(
              text(checkRun.status),
              text(checkRun.conclusion),
            ),
            url: text(checkRun.details_url) ?? text(checkRun.html_url),
            checkSuiteId,
            source: "WEBHOOK",
            githubUpdatedAt: updatedAtValue ? new Date(updatedAtValue) : null,
          },
        ],
      });
      return true;
    }

    const job = payload.workflow_job as Record<string, unknown> | undefined;
    const workflowRunId = positiveInteger(job?.run_id)?.toString() ?? null;
    if (!job || !workflowRunId) return false;
    const updatedAtValue =
      text(job.completed_at) ?? text(job.started_at) ?? text(job.created_at);
    const githubUpdatedAt = updatedAtValue ? new Date(updatedAtValue) : null;
    const steps: GitHubWorkflowJobView["steps"] = Array.isArray(job.steps)
      ? job.steps.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return [];
          }
          const step = entry as Record<string, unknown>;
          const number = positiveInteger(step.number);
          if (!number) return [];
          return [
            {
              number,
              name: text(step.name) ?? `Step ${number}`,
              status: normalizePipelineState(
                text(step.status),
                text(step.conclusion),
              ),
            },
          ];
        })
      : [];
    const jobView: GitHubWorkflowJobView = {
      id: positiveInteger(job.id)?.toString() ?? text(job.node_id) ?? "unknown",
      name: text(job.name) ?? "Workflow job",
      status: normalizePipelineState(text(job.status), text(job.conclusion)),
      url: text(job.html_url),
      canRetry: text(job.status)?.toLowerCase() === "completed",
      retryUnavailableReason:
        text(job.status)?.toLowerCase() === "completed"
          ? null
          : "NOT_COMPLETED",
      steps,
      runAttempt: positiveInteger(job.run_attempt),
    };
    await this.pipelineStatus.observeSnapshot({
      repositoryGithubId,
      repositoryNameWithOwner,
      repositoryUrl,
      headSha,
      pipelines: [
        {
          id: workflowRunId,
          name: text(job.workflow_name) ?? "GitHub Actions",
          status: childPipelineState(text(job.status), text(job.conclusion)),
          url: text(job.html_url),
          workflowRunId,
          runAttempt: positiveInteger(job.run_attempt),
          source: "WEBHOOK",
          githubUpdatedAt,
        },
      ],
    });
    await this.pipelineStatus.observeJobs(
      repositoryGithubId,
      workflowRunId,
      [jobView],
      "WEBHOOK",
      githubUpdatedAt,
    );
    return true;
  }

  private async recordWebhookTrigger(
    target: RepositoryTarget,
    event: string,
    action: string | null,
    deliveryId: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.workflowEvents) return false;
    const repository = (payload.repository ?? {}) as Record<string, unknown>;
    const pullRequest = (payload.pull_request ?? {}) as Record<string, unknown>;
    const review = (payload.review ?? {}) as Record<string, unknown>;
    const comment = (payload.comment ?? {}) as Record<string, unknown>;
    const check = (payload.check_run ?? payload.check_suite ?? {}) as Record<
      string,
      unknown
    >;
    let kind: string | null = null;
    if (
      event === "pull_request" &&
      new Set(["opened", "reopened", "ready_for_review"]).has(action ?? "")
    ) {
      kind = "GITHUB_PR_STATE";
    } else if (event === "pull_request" && action === "synchronize") {
      kind = "GITHUB_PR_SYNCHRONIZED";
    } else if (event === "pull_request" && action === "closed") {
      kind = "GITHUB_PR_CLOSED";
    } else if (event === "pull_request" && action === "labeled") {
      kind = "GITHUB_PR_LABEL";
    } else if (
      event === "pull_request_review" &&
      action === "submitted" &&
      text(review.state)?.toLowerCase() === "changes_requested"
    ) {
      kind = "GITHUB_REVIEW_CHANGES_REQUESTED";
    } else if (
      event === "pull_request_review" &&
      action === "submitted" &&
      text(review.state)?.toLowerCase() === "approved"
    ) {
      kind = "GITHUB_REVIEW_APPROVED";
    } else if (
      event === "pull_request_review_comment" &&
      action === "created"
    ) {
      kind = "GITHUB_REVIEW_COMMENT";
    } else if (
      (event === "check_run" || event === "check_suite") &&
      FAILURE_CONCLUSIONS.has(text(check.conclusion)?.toLowerCase() ?? "")
    ) {
      kind = "GITHUB_CHECK_FAILED";
    } else if (
      event === "push" &&
      text(payload.ref) === `refs/heads/${text(repository.default_branch)}`
    ) {
      kind = "GITHUB_PUSH_DEFAULT";
    } else if (event === "issue_comment" && action === "created") {
      kind = "GITHUB_ISSUE_COMMAND";
    }
    if (!kind) return false;
    const user = (comment.user ?? {}) as Record<string, unknown>;
    const labels = Array.isArray(pullRequest.labels)
      ? pullRequest.labels.flatMap((value) => {
          const name =
            value && typeof value === "object"
              ? text((value as Record<string, unknown>).name)
              : null;
          return name ? [name] : [];
        })
      : [];
    const pullRequestHead = pullRequest.head as
      Record<string, unknown> | undefined;
    const pullRequestBase = pullRequest.base as
      Record<string, unknown> | undefined;
    const checkSuite = (check.check_suite ??
      payload.check_suite ??
      {}) as Record<string, unknown>;
    const headBranch = text(pullRequestHead?.ref);
    const pushedBranch =
      text(payload.ref)?.replace(/^refs\/heads\//, "") ?? null;
    const checkedBranch =
      text(check.head_branch) ?? text(checkSuite.head_branch);
    const linkedBranch = headBranch ?? pushedBranch ?? checkedBranch;
    const prisma = await getPrismaClient();
    const codebaseSettings = await prisma.codebaseSettings.findUnique({
      where: { id: "default" },
    });
    const ticketKey = jiraKeyFromBranch(
      linkedBranch,
      target.jiraBranchRegex ?? codebaseSettings?.defaultJiraBranchRegex ?? "",
    );
    const worktree = linkedBranch
      ? await prisma.worktree.findFirst({
          where: {
            branch: linkedBranch,
            primary: false,
            missingAt: null,
            codebase: { repositoryId: target.id },
          },
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            folder: true,
            branch: true,
            baseBranchOverride: true,
            headSha: true,
            pushStatus: true,
            hasStagedChanges: true,
            hasUnstagedChanges: true,
            codebase: {
              select: {
                id: true,
                folder: true,
                agentId: true,
                branch: true,
                headSha: true,
                defaultBranch: true,
                agent: {
                  select: { id: true, name: true, hostname: true },
                },
              },
            },
          },
        })
      : null;
    const sessionData = {
      repo: {
        id: target.id,
        name: target.name,
        owner: target.owner,
        url: text(repository.html_url),
        canonicalOrigin: target.canonicalOrigin,
        displayOrigin: text(repository.full_name) ?? target.displayOrigin,
        defaultBranch: text(repository.default_branch),
      },
      pr: {
        number:
          positiveInteger(pullRequest.number) ??
          positiveInteger(
            (payload.issue as Record<string, unknown> | undefined)?.number,
          ),
        url: text(pullRequest.html_url),
        state: text(pullRequest.state)?.toUpperCase() ?? null,
        merged: pullRequest.merged === true,
        labels,
        title: text(pullRequest.title),
        isDraft: pullRequest.draft === true,
        headBranch,
        headSha: text(pullRequestHead?.sha),
        baseBranch: text(pullRequestBase?.ref),
        reviewDecision: text(review.state)?.toUpperCase() ?? null,
      },
      pipeline: {
        checkSuiteId: positiveInteger(check.id)?.toString() ?? null,
        status: text(check.status),
        conclusion: text(check.conclusion),
        headBranch: checkedBranch,
        headSha: text(check.head_sha) ?? text(checkSuite.head_sha),
      },
      comment: {
        id: positiveInteger(comment.id)?.toString() ?? null,
        body: text(comment.body) ?? "",
        author: { login: text(user.login) },
      },
      push: {
        ref: text(payload.ref),
        before: text(payload.before),
        after: text(payload.after),
      },
      ...(worktree
        ? {
            worktree: {
              id: worktree.id,
              path: worktree.folder,
              branch: worktree.branch,
              baseBranch:
                worktree.baseBranchOverride ?? worktree.codebase.defaultBranch,
              headSha: worktree.headSha,
              pushStatus: worktree.pushStatus,
              dirty: worktree.hasStagedChanges || worktree.hasUnstagedChanges,
            },
            codebase: {
              id: worktree.codebase.id,
              folder: worktree.codebase.folder,
              agentId: worktree.codebase.agentId,
              branch: worktree.codebase.branch,
              headSha: worktree.codebase.headSha,
            },
            agent: worktree.codebase.agent,
          }
        : {}),
      ...(ticketKey ? { ticket: { key: ticketKey } } : {}),
    };
    await this.workflowEvents.record({
      kind,
      subjectKey: target.id,
      dedupeKey: `github-webhook-trigger:${deliveryId}:${kind}`,
      payload: {
        ...sessionData,
        sessionData,
        cursorValue: `${deliveryId}:${kind}`,
        webhook: { event, action, deliveryId },
      },
    });
    return true;
  }

  private schedule(seconds: number): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(30, seconds) * 1_000;
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref();
    this.polling.schedule(OPERATION_ID, new Date(Date.now() + delay));
  }

  configurationChanged(): void {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    queueMicrotask(() => void this.tick());
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
    try {
      const prisma = await getPrismaClient();
      const [settings, app, tokenConfigured, webhookSecretConfigured] =
        await Promise.all([
          prisma.gitHubSettings.upsert({
            where: { id: "default" },
            create: { id: "default" },
            update: {},
          }),
          prisma.gitHubAppSettings.findUnique({ where: { id: "default" } }),
          this.credentials.isConfigured(CREDENTIALS.githubPersonalAccessToken),
          this.credentials.isConfigured(CREDENTIALS.githubAppWebhookSecret),
        ]);
      intervalSeconds = settings.actionsNotificationPollIntervalSeconds;
      const webhookConfigured = Boolean(
        app?.webhookUrl && app.webhookConfiguredAt && webhookSecretConfigured,
      );
      if (webhookConfigured) {
        this.polling.configure(OPERATION_ID, {
          enabled: false,
          cadenceSeconds: intervalSeconds,
          details: { mode: "WEBHOOK" },
        });
        return;
      }
      if (!tokenConfigured) {
        this.polling.configure(OPERATION_ID, {
          enabled: false,
          cadenceSeconds: intervalSeconds,
          details: { mode: "DISABLED", reason: "GITHUB_TOKEN_REQUIRED" },
        });
        return;
      }
      this.polling.configure(OPERATION_ID, {
        enabled: true,
        cadenceSeconds: intervalSeconds,
        details: { mode: "POLLING" },
      });
      await this.polling.run(
        OPERATION_ID,
        () => this.pollRepositories(),
        (result) => result,
      );
    } catch {
      // The polling coordinator retains the error for the dashboard.
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        queueMicrotask(() => void this.tick());
      } else {
        this.schedule(intervalSeconds);
      }
    }
  }

  private async repositories(): Promise<RepositoryTarget[]> {
    const repositories = await (
      await getPrismaClient()
    ).codebaseRepository.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        canonicalOrigin: true,
        displayOrigin: true,
        jiraBranchRegex: true,
      },
    });
    return repositories.flatMap((repository) => {
      const match = /^github\.com\/([^/]+)\/([^/]+)$/i.exec(
        repository.canonicalOrigin.trim(),
      );
      if (!match?.[1] || !match[2]) return [];
      return [
        {
          id: repository.id,
          name: repository.name,
          owner: match[1],
          repository: match[2],
          canonicalOrigin: repository.canonicalOrigin,
          displayOrigin: repository.displayOrigin,
          jiraBranchRegex: repository.jiraBranchRegex,
        },
      ];
    });
  }

  private async fetchRuns(
    target: RepositoryTarget,
    token: string,
    updatedAfter: Date | null,
  ): Promise<WorkflowRun[]> {
    const runs: WorkflowRun[] = [];
    for (let page = 1; ; page += 1) {
      const url = `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/actions/runs?per_page=${GITHUB_RUNS_PAGE_SIZE}&page=${page}`;
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
            operation: GITHUB_REST_OPERATIONS.actions.listWorkflowRunsForRepo,
            requestSource: "ACTIONS_NOTIFICATIONS",
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
        const message = error instanceof Error ? error.message : String(error);
        await record({ error: message });
        throw error;
      }
      const rateLimit = await observeGitHubRateLimit("PAT", response);
      const body = (await response.json().catch(() => null)) as {
        workflow_runs?: Array<Record<string, unknown>>;
        message?: string;
      } | null;
      if (!response.ok || !Array.isArray(body?.workflow_runs)) {
        const error =
          body?.message ||
          `GitHub returned HTTP ${response.status} while polling ${target.owner}/${target.repository}`;
        await record({ statusCode: response.status, error, rateLimit });
        throw new Error(error);
      }
      await record({ statusCode: response.status, rateLimit });
      const pageRuns = body.workflow_runs.flatMap((run) => {
        const id = positiveInteger(run.id);
        const workflowId = positiveInteger(run.workflow_id);
        const updatedAtValue = text(run.updated_at);
        const updatedAt = updatedAtValue ? new Date(updatedAtValue) : null;
        const repository = run.repository as
          Record<string, unknown> | undefined;
        if (
          !id ||
          !workflowId ||
          !updatedAt ||
          !Number.isFinite(updatedAt.getTime())
        ) {
          return [];
        }
        return [
          {
            id: String(id),
            workflowId: String(workflowId),
            runAttempt: positiveInteger(run.run_attempt) ?? 1,
            name: text(run.name) ?? "GitHub Actions",
            displayTitle:
              text(run.display_title) ?? text(run.name) ?? "Workflow run",
            status: text(run.status)?.toLowerCase() ?? "unknown",
            conclusion: text(run.conclusion)?.toLowerCase() ?? null,
            headBranch: text(run.head_branch),
            headSha: text(run.head_sha),
            pullRequests: workflowPullRequests(run.pull_requests),
            url: text(run.html_url) ?? "",
            updatedAt,
            repositoryGithubId: text(repository?.node_id),
            repositoryNameWithOwner:
              text(repository?.full_name) ??
              `${target.owner}/${target.repository}`,
            repositoryUrl:
              text(repository?.html_url) ??
              `https://github.com/${target.owner}/${target.repository}`,
            checkSuiteId: text(run.check_suite_node_id),
          },
        ];
      });
      runs.push(...pageRuns);
      if (
        !updatedAfter ||
        body.workflow_runs.length < GITHUB_RUNS_PAGE_SIZE ||
        pageRuns.some((run) => run.updatedAt <= updatedAfter)
      ) {
        return runs;
      }
    }
  }

  private async worktreeContext(
    transaction: Prisma.TransactionClient,
    codebaseRepositoryId: string,
    branch: string | null,
  ): Promise<{ id: string; highlightColor: string | null } | null> {
    if (!branch) return null;
    return transaction.worktree.findFirst({
      where: {
        branch,
        missingAt: null,
        codebase: { repositoryId: codebaseRepositoryId },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, highlightColor: true },
    });
  }

  private async observeRun(
    transaction: Prisma.TransactionClient,
    target: RepositoryTarget,
    run: WorkflowRun,
    source: "POLL" | "WEBHOOK",
    shouldNotifyNewRun: boolean,
  ): Promise<NotificationRecord | null> {
    const now = new Date();
    const typeKey = notificationType(run.conclusion);
    const existing = await transaction.gitHubWorkflowRunObservation.findUnique({
      where: {
        codebaseRepositoryId_workflowRunId_runAttempt: {
          codebaseRepositoryId: target.id,
          workflowRunId: run.id,
          runAttempt: run.runAttempt,
        },
      },
    });
    await transaction.gitHubWorkflowRunObservation.upsert({
      where: {
        codebaseRepositoryId_workflowRunId_runAttempt: {
          codebaseRepositoryId: target.id,
          workflowRunId: run.id,
          runAttempt: run.runAttempt,
        },
      },
      create: {
        id: randomUUID(),
        codebaseRepositoryId: target.id,
        workflowRunId: run.id,
        runAttempt: run.runAttempt,
        workflowId: run.workflowId,
        status: run.status,
        conclusion: run.conclusion,
        githubUpdatedAt: run.updatedAt,
        source,
        lastObservedAt: now,
      },
      update: {
        workflowId: run.workflowId,
        status: run.status,
        conclusion: run.conclusion,
        githubUpdatedAt: run.updatedAt,
        source,
        lastObservedAt: now,
      },
    });
    const isNewTerminalTransition = existing
      ? existing.status !== "completed" ||
        existing.conclusion !== run.conclusion
      : shouldNotifyNewRun;
    if (
      !isNewTerminalTransition ||
      !typeKey ||
      run.status !== "completed" ||
      existing?.notifiedAt
    ) {
      return null;
    }
    const worktree = await this.worktreeContext(
      transaction,
      target.id,
      run.headBranch,
    );
    const params = new URLSearchParams({ repository: target.id });
    if (run.headBranch) params.set("branch", run.headBranch);
    params.set("pipeline", run.workflowId);
    const notification = await this.notifications.recordInTransaction(
      transaction,
      {
        dedupeKey: `github-actions:${target.id}:${run.id}:${run.runAttempt}`,
        typeKey,
        title:
          typeKey === "GITHUB_ACTIONS_SUCCEEDED"
            ? "GitHub Actions succeeded"
            : "GitHub Actions failed",
        body: [target.name, run.name, run.headBranch]
          .filter((value): value is string => Boolean(value))
          .join(" · "),
        href: `/actions?${params.toString()}`,
        resourceKind: "GITHUB_WORKFLOW_RUN",
        resourceId: `${target.id}:${run.id}:${run.runAttempt}`,
        worktreeId: worktree?.id ?? null,
        highlightColor: worktree?.highlightColor ?? null,
      },
    );
    await transaction.gitHubWorkflowRunObservation.update({
      where: {
        codebaseRepositoryId_workflowRunId_runAttempt: {
          codebaseRepositoryId: target.id,
          workflowRunId: run.id,
          runAttempt: run.runAttempt,
        },
      },
      data: { notifiedAt: now },
    });
    return notification;
  }

  private async pollRepository(
    target: RepositoryTarget,
    token: string,
    appConfigured: boolean,
  ): Promise<number> {
    const prisma = await getPrismaClient();
    const startedAt = new Date();
    const state = await prisma.gitHubActionsPollingState.findUnique({
      where: { codebaseRepositoryId: target.id },
    });
    await prisma.gitHubActionsPollingState.upsert({
      where: { codebaseRepositoryId: target.id },
      create: {
        codebaseRepositoryId: target.id,
        initializedAt: startedAt,
        lastPollStartedAt: startedAt,
      },
      update: { lastPollStartedAt: startedAt },
    });
    try {
      const runs = await this.fetchRuns(
        target,
        token,
        state ? (state.lastPollSucceededAt ?? state.initializedAt) : null,
      );
      const notifications: NotificationRecord[] = [];
      await prisma.$transaction(async (transaction) => {
        for (const run of runs) {
          const created = await this.observeRun(
            transaction,
            target,
            run,
            "POLL",
            Boolean(
              state &&
              run.updatedAt >
                (state.lastPollSucceededAt ?? state.initializedAt),
            ),
          );
          if (created) notifications.push(created);
        }
        const completedAt = new Date();
        await transaction.gitHubActionsPollingState.update({
          where: { codebaseRepositoryId: target.id },
          data: {
            lastPollCompletedAt: completedAt,
            lastPollSucceededAt: completedAt,
            lastError: null,
          },
        });
      });
      notifications.forEach((notification) =>
        this.notifications.created(notification),
      );
      await Promise.allSettled(
        runs.flatMap((run) => [
          this.observePipelineRun(target, run, "REST", appConfigured),
          this.recordWorkflowRunEvent(target, run),
        ]),
      );
      return notifications.length;
    } catch (error) {
      await prisma.gitHubActionsPollingState.update({
        where: { codebaseRepositoryId: target.id },
        data: {
          lastPollCompletedAt: new Date(),
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  private async pollRepositories(): Promise<Record<string, unknown>> {
    const token = await this.credentials.getText(
      CREDENTIALS.githubPersonalAccessToken,
    );
    if (!token) throw new Error("GitHub personal access token is unavailable");
    const [repositories, appSettings, privateKeyConfigured] = await Promise.all(
      [
        this.repositories(),
        (await getPrismaClient()).gitHubAppSettings.findUnique({
          where: { id: "default" },
          select: { id: true },
        }),
        this.credentials.isConfigured(CREDENTIALS.githubAppPrivateKey),
      ],
    );
    const appConfigured = Boolean(appSettings && privateKeyConfigured);
    const results = await Promise.allSettled(
      repositories.map((repository) =>
        this.pollRepository(repository, token, appConfigured),
      ),
    );
    const failures = results.filter((result) => result.status === "rejected");
    const notificationsCreated = results.reduce(
      (count, result) =>
        count + (result.status === "fulfilled" ? result.value : 0),
      0,
    );
    await this.prune();
    if (failures.length === repositories.length && repositories.length > 0) {
      throw failures[0]!.reason;
    }
    return {
      mode: "POLLING",
      repositories: repositories.length,
      failures: failures.length,
      notificationsCreated,
    };
  }

  private async prune(): Promise<void> {
    const before = new Date(Date.now() - RETENTION_MS);
    const prisma = await getPrismaClient();
    await Promise.all([
      prisma.gitHubWorkflowRunObservation.deleteMany({
        where: { lastObservedAt: { lt: before } },
      }),
      prisma.gitHubWebhookDelivery.deleteMany({
        where: { receivedAt: { lt: before } },
      }),
    ]);
  }

  async handleWebhook(input: {
    body: Uint8Array;
    signature: string | null;
    event: string | null;
    deliveryId: string | null;
  }): Promise<WebhookResult> {
    const secret = await this.credentials.getText(
      CREDENTIALS.githubAppWebhookSecret,
    );
    if (!secret) throw new Error("GitHub webhook is not configured");
    if (!input.signature?.startsWith("sha256=")) {
      throw new Error("GitHub webhook signature is missing");
    }
    const expected = `sha256=${createHmac("sha256", secret)
      .update(input.body)
      .digest("hex")}`;
    if (!secureEqual(expected, input.signature)) {
      throw new Error("GitHub webhook signature is invalid");
    }
    if (!input.deliveryId?.trim()) {
      throw new Error("GitHub delivery ID is missing");
    }
    const prisma = await getPrismaClient();
    const deliveryId = input.deliveryId.trim();
    try {
      await prisma.gitHubWebhookDelivery.create({
        data: {
          deliveryId,
          event: input.event ?? "unknown",
          outcome: "RECEIVED",
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const retried = await prisma.gitHubWebhookDelivery.updateMany({
          where: {
            deliveryId,
            outcome: { notIn: ["PROCESSED", "IGNORED"] },
          },
          data: {
            event: input.event ?? "unknown",
            action: null,
            repositoryName: null,
            workflowRunId: null,
            outcome: "RECEIVED",
            error: null,
            receivedAt: new Date(),
            processedAt: null,
          },
        });
        if (retried.count === 0) {
          return { outcome: "DUPLICATE", notificationCreated: false };
        }
      } else {
        throw error;
      }
    }
    const finish = async (
      outcome: string,
      error: string | null = null,
    ): Promise<void> => {
      await prisma.gitHubWebhookDelivery.update({
        where: { deliveryId },
        data: { outcome, error, processedAt: new Date() },
      });
    };
    try {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(
          Buffer.from(input.body).toString("utf8"),
        ) as Record<string, unknown>;
      } catch {
        throw new Error("GitHub webhook payload is invalid JSON");
      }
      const action = text(payload.action);
      const repository = payload.repository as
        Record<string, unknown> | undefined;
      const workflow = payload.workflow_run as
        Record<string, unknown> | undefined;
      await prisma.gitHubWebhookDelivery.update({
        where: { deliveryId },
        data: {
          action,
          repositoryName: text(repository?.full_name),
          workflowRunId: positiveInteger(workflow?.id)?.toString() ?? null,
        },
      });
      if (input.event !== "workflow_run" || action !== "completed") {
        const app = await prisma.gitHubAppSettings.findUnique({
          where: { id: "default" },
        });
        const installation = payload.installation as
          Record<string, unknown> | undefined;
        if (
          !app ||
          String(positiveInteger(installation?.id) ?? "") !== app.installationId
        ) {
          await finish("IGNORED", "Installation does not match configured App");
          return { outcome: "IGNORED", notificationCreated: false };
        }
        const fullName = text(repository?.full_name);
        const target = fullName
          ? (await this.repositories()).find(
              (candidate) =>
                `${candidate.owner}/${candidate.repository}`.toLowerCase() ===
                fullName.toLowerCase(),
            )
          : null;
        if (!target) {
          await finish("IGNORED", "Repository is not registered");
          return { outcome: "IGNORED", notificationCreated: false };
        }
        const event = input.event ?? "unknown";
        const [pipelineRecorded, triggerRecorded] = await Promise.all([
          app.enhancedPipelineWebhooksEnabled
            ? this.observeEnhancedWebhook(target, event, action, payload)
            : false,
          this.recordWebhookTrigger(target, event, action, deliveryId, payload),
        ]);
        const recorded = pipelineRecorded || triggerRecorded;
        await finish(recorded ? "PROCESSED" : "IGNORED");
        return {
          outcome: recorded ? "PROCESSED" : "IGNORED",
          notificationCreated: false,
        };
      }
      const app = await prisma.gitHubAppSettings.findUnique({
        where: { id: "default" },
      });
      const installation = payload.installation as
        Record<string, unknown> | undefined;
      if (
        !app ||
        String(positiveInteger(installation?.id) ?? "") !== app.installationId
      ) {
        await finish("IGNORED", "Installation does not match configured App");
        return { outcome: "IGNORED", notificationCreated: false };
      }
      const fullName = text(repository?.full_name);
      const runId = positiveInteger(workflow?.id);
      const workflowId = positiveInteger(workflow?.workflow_id);
      const updatedAtText = text(workflow?.updated_at);
      if (!fullName || !runId || !workflowId || !updatedAtText) {
        throw new Error("GitHub workflow_run payload is incomplete");
      }
      const target = (await this.repositories()).find(
        (candidate) =>
          `${candidate.owner}/${candidate.repository}`.toLowerCase() ===
          fullName.toLowerCase(),
      );
      if (!target) {
        await finish("IGNORED", "Repository is not registered");
        return { outcome: "IGNORED", notificationCreated: false };
      }
      const run = webhookWorkflowRun(target, repository, workflow);
      if (!run) throw new Error("GitHub workflow_run payload is incomplete");
      let notification: NotificationRecord | null = null;
      await prisma.$transaction(async (transaction) => {
        notification = await this.observeRun(
          transaction,
          target,
          run,
          "WEBHOOK",
          true,
        );
      });
      this.notifications.created(notification);
      await this.observePipelineRun(target, run, "WEBHOOK");
      await this.recordWorkflowRunEvent(target, run);
      await finish("PROCESSED");
      this.polling.configure(OPERATION_ID, {
        enabled: false,
        details: {
          mode: "WEBHOOK",
          lastDeliveryId: deliveryId,
          lastDeliveryAt: new Date().toISOString(),
        },
      });
      void this.prune().catch(() => undefined);
      return {
        outcome: "PROCESSED",
        notificationCreated: Boolean(notification),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finish("ERROR", message);
      throw error;
    }
  }
}
