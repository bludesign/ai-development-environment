import "server-only";

import {
  BUILD_ACTIONS,
  type BuildAction,
} from "@ai-development-environment/agent-contract/builds";
import {
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_REFRESH_JOB_KIND,
  CODEBASE_GIT_OPERATIONS,
  type CodebaseGitOperation,
} from "@ai-development-environment/agent-contract/codebases";
import {
  WORKTREE_GIT_OPERATIONS,
  WORKTREE_OPERATIONS,
  type WorktreeGitOperation,
  type WorktreeOperation,
} from "@ai-development-environment/agent-contract/worktrees";

import { getPrismaClient } from "@/data/prisma-client";
import type { AgentControlService } from "@/services/agent-control";
import type { BuildsService } from "@/services/builds";
import type { CodebasesService } from "@/services/codebases";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import type { NotificationsService } from "@/services/notifications";
import type { PushNotificationsService } from "@/services/push-notifications";
import type { RunsService } from "@/services/runs";
import type { SkillsService } from "@/services/skills";
import type { ToolsService } from "@/services/tools";
import type { WorktreesService } from "@/services/worktrees";
import type { RunConfigurationInput } from "@/services/runs";
import { pullRequestResourceId } from "@/lib/workflows/resources";
import { getSessionValue } from "@/lib/workflows/session";
import type {
  WorkflowExecutionContext,
  WorkflowExecutionResult,
  WorkflowStepExecutor,
} from "./step-executor";
import type { WorkflowsService } from "./workflows.service";

export type WorkflowAdapterServices = {
  agentControl: AgentControlService;
  jira: JiraService;
  github: GitHubService;
  worktrees: WorktreesService;
  codebases: CodebasesService;
  builds: BuildsService;
  skills: SkillsService;
  runs: RunsService;
  notifications: NotificationsService;
  pushNotifications: PushNotificationsService;
  tools: ToolsService;
};

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string, maximum = 20_000): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  if (value.length > maximum) throw new Error(`${label} is too long`);
  return value.trim();
};

const optionalText = (value: unknown, maximum = 20_000): string | null => {
  if (value === null || value === undefined || value === "") return null;
  return text(value, "Value", maximum);
};

const configuredId = (
  context: WorkflowExecutionContext,
  configKey: string,
  sessionPath: string,
  label: string,
): string =>
  text(
    context.node.config[configKey] ??
      getSessionValue(context.sessionData, sessionPath),
    label,
    500,
  );

const requestId = (context: WorkflowExecutionContext, suffix = "operation") =>
  `${context.run.id}:${context.attempt.id}:${suffix}`;

const runResult = (
  context: WorkflowExecutionContext,
  run: Record<string, unknown>,
  wait = false,
): WorkflowExecutionResult => ({
  output: run,
  sessionPatch: { run: { [context.node.id]: run } },
  links:
    typeof run.id === "string"
      ? [
          {
            kind: "AGENT_RUN",
            resourceId: run.id,
            label: typeof run.kind === "string" ? run.kind : "Agent run",
            url: `/${run.kind === "PLAN" ? "plans" : "sessions"}/${run.id}`,
          },
        ]
      : undefined,
  wait:
    wait && typeof run.id === "string"
      ? {
          kind: "AGENT_RUN",
          externalKey: run.id,
          resumeAfter: new Date(Date.now() + 1_000),
        }
      : undefined,
});

const jobResult = (
  job: { id: string; timeoutSeconds?: number | null },
  sessionPatch?: Record<string, unknown>,
): WorkflowExecutionResult => ({
  output: { jobId: job.id },
  sessionPatch,
  links: [
    {
      kind: "AGENT_JOB",
      resourceId: job.id,
      label: "Agent job",
      url: `/jobs/${job.id}`,
    },
  ],
  wait: {
    kind: "AGENT_JOB",
    externalKey: job.id,
    resumeAfter: new Date(Date.now() + 1_000),
    timeoutAt: new Date(
      Date.now() + Math.max(10, job.timeoutSeconds ?? 3_600) * 1_000,
    ),
  },
});

function githubCoordinates(context: WorkflowExecutionContext): {
  owner: string;
  name: string;
} {
  const owner = context.node.config.owner;
  const name = context.node.config.name;
  if (typeof owner === "string" && typeof name === "string") {
    return { owner, name };
  }
  const origin =
    context.sessionData.repo &&
    typeof context.sessionData.repo === "object" &&
    !Array.isArray(context.sessionData.repo)
      ? (context.sessionData.repo as Record<string, unknown>).displayOrigin
      : null;
  const match =
    typeof origin === "string"
      ? origin.match(
          /(?:https?:\/\/)?github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i,
        )
      : null;
  if (!match?.[1] || !match[2]) {
    throw new Error("GitHub owner and repository are required");
  }
  return { owner: match[1], name: match[2] };
}

function normalizeTicket(ticketValue: unknown): Record<string, unknown> {
  const ticket = object(ticketValue, "Jira ticket");
  const issueType =
    ticket.issueType && typeof ticket.issueType === "object"
      ? (ticket.issueType as Record<string, unknown>)
      : {};
  const status =
    ticket.status && typeof ticket.status === "object"
      ? (ticket.status as Record<string, unknown>)
      : {};
  return {
    ...ticket,
    key: ticket.key,
    title: ticket.summary ?? ticket.title,
    type: issueType.name ?? ticket.type,
    status: status.name ?? ticket.status,
    statusCategory: status.category ?? ticket.statusCategory,
  };
}

function normalizePullRequest(value: unknown): Record<string, unknown> {
  const pullRequest = object(value, "Pull request");
  const threads = Array.isArray(pullRequest.reviewThreads)
    ? pullRequest.reviewThreads
    : [];
  return {
    ...pullRequest,
    unresolvedThreads: threads.filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).isResolved !== true,
    ),
  };
}

export function registerWorkflowAdapters(
  workflows: WorkflowsService,
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  registerWaitPollers(workflows, services);
  registerJiraAdapters(executor, services);
  registerGitHubAdapters(executor, services);
  registerWorktreeAdapters(executor, services);
  registerCodebaseAdapters(executor, services);
  registerBuildAdapters(executor, services);
  registerRunAdapters(executor, services);
  registerMiscellaneousAdapters(executor, services);
}

function registerWaitPollers(
  workflows: WorkflowsService,
  services: WorkflowAdapterServices,
): void {
  workflows.registerWaitPoller("AGENT_JOB", async (jobId) => {
    const job = await services.agentControl.getJob(jobId);
    if (!job) return { pending: false, error: "Agent job disappeared" };
    if (new Set(["QUEUED", "RUNNING"]).has(job.status)) {
      return { pending: true, pollAfterSeconds: 2 };
    }
    return {
      pending: false,
      result: job.resultJson
        ? { ...object(JSON.parse(job.resultJson), "Agent job result"), jobId }
        : { jobId, status: job.status },
      error:
        job.status === "SUCCEEDED"
          ? null
          : job.error || `Agent job ${job.status.toLowerCase()}`,
    };
  });
  workflows.registerWaitPoller("AGENT_RUN", async (runId) => {
    const run = await services.runs.get(runId);
    if (!run) return { pending: false, error: "Plan or session disappeared" };
    if (new Set(["IN_PROGRESS", "PAUSED"]).has(run.status)) {
      return { pending: true, pollAfterSeconds: 3 };
    }
    return {
      pending: false,
      result: {
        id: run.id,
        kind: run.kind,
        status: run.status,
        phase: run.phase,
        finalOutput: run.finalOutput,
        error: run.error,
        usage: {
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          reasoningTokens: run.reasoningTokens,
          estimatedCost: run.estimatedCost,
        },
      },
      error:
        run.status === "COMPLETED"
          ? null
          : run.error || `Run ${run.status.toLowerCase()}`,
    };
  });
  workflows.registerWaitPoller("BUILD", async (buildId) => {
    const build = await services.builds.getBuild(buildId);
    if (!build) return { pending: false, error: "Build disappeared" };
    if (new Set(["QUEUED", "PREPARING", "RUNNING"]).has(build.status)) {
      return { pending: true, pollAfterSeconds: 3 };
    }
    return {
      pending: false,
      result: { id: build.id, status: build.status, action: build.action },
      error:
        build.status === "SUCCEEDED"
          ? null
          : build.error || `Build ${build.status.toLowerCase()}`,
    };
  });
  workflows.registerWaitPoller("SKILL_RUN", async (runId) => {
    let run = await services.skills.getRun(runId);
    if (!run) return { pending: false, error: "Skill run disappeared" };
    if (run.status === "READY") run = await services.skills.applyRun(runId);
    if (new Set(["PREPARING", "READY", "APPLYING"]).has(run?.status ?? "")) {
      return { pending: true, pollAfterSeconds: 3 };
    }
    return {
      pending: false,
      result: { id: runId, status: run?.status },
      error:
        run?.status === "SUCCEEDED"
          ? null
          : run?.error || `Skill run ${run?.status?.toLowerCase()}`,
    };
  });
  workflows.registerWaitPoller("WORKTREE_MOVE", async (moveId) => {
    const move = await services.worktrees.getMove(moveId);
    if (!move) return { pending: false, error: "Worktree move disappeared" };
    if (
      new Set(["PUSHING", "CHECKING_OUT", "DELETING_SOURCE"]).has(move.status)
    ) {
      return { pending: true, pollAfterSeconds: 3 };
    }
    return {
      pending: false,
      result: {
        id: move.id,
        status: move.status,
        targetWorktreeId: move.targetWorktreeId,
      },
      error:
        move.status === "SUCCEEDED"
          ? null
          : move.error || `Worktree move ${move.status.toLowerCase()}`,
    };
  });
  workflows.registerWaitPoller("WORKTREE_PUSH_READY", async (worktreeId) => {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findUnique({
      where: { id: worktreeId },
    });
    if (!worktree) return { pending: false, error: "Worktree disappeared" };
    if (worktree.pushStatus !== "READY")
      return { pending: true, pollAfterSeconds: 5 };
    return {
      pending: false,
      result: { id: worktree.id, pushStatus: worktree.pushStatus },
    };
  });
  workflows.registerWaitPoller("WORKFLOW_RUN", async (runId) => {
    const run = await workflows.run(runId);
    if (!run) return { pending: false, error: "Sub-workflow disappeared" };
    if (!new Set(["SUCCEEDED", "FAILED", "CANCELLED"]).has(run.status)) {
      return { pending: true, pollAfterSeconds: 3 };
    }
    return {
      pending: false,
      result: {
        id: run.id,
        status: run.status,
        sessionData: JSON.parse(run.sessionDataJson),
      },
      error:
        run.status === "SUCCEEDED"
          ? null
          : run.error || `Sub-workflow ${run.status.toLowerCase()}`,
    };
  });
  workflows.registerWaitPoller("RUN_ANSWER_REVISION", async (externalKey) => {
    const input = object(JSON.parse(externalKey), "Answer revision wait");
    const batchId = text(input.batchId, "Question batch ID", 500);
    const batch = await services.runs.questionBatch(batchId);
    if (!batch) return { pending: false, error: "Question batch disappeared" };
    if (!batch.revisionPreparedAt) {
      return { pending: true, pollAfterSeconds: 2 };
    }
    const run = await services.runs.reviseAnswer(
      batchId,
      input.answers ?? {},
      input.stash === true,
      input.rollback !== false,
    );
    if (!run) return { pending: false, error: "Answer revision failed" };
    return {
      pending: false,
      result: {
        id: run.id,
        kind: run.kind,
        status: run.status,
        phase: run.phase,
        parentRunId: run.parentRunId,
        followUpMode: run.followUpMode,
      },
    };
  });
  workflows.registerWaitPoller("GITHUB_CHECKS", async (externalKey) => {
    const input = object(JSON.parse(externalKey), "GitHub checks wait");
    const run = await services.github.autoRetryRun(
      text(input.repositoryId, "Repository ID"),
      text(input.workflowRunId, "Workflow run ID"),
      true,
    );
    if (
      !new Set([
        "SUCCESS",
        "FAILURE",
        "CANCELLED",
        "SKIPPED",
        "TIMED_OUT",
        "ACTION_REQUIRED",
        "ERROR",
        "NEUTRAL",
        "STALE",
        "STARTUP_FAILURE",
      ]).has(run.status)
    ) {
      return { pending: true, pollAfterSeconds: 10 };
    }
    return {
      pending: false,
      result: { runId: run.id, status: run.status, jobs: run.jobs },
      error:
        run.status === "SUCCESS"
          ? null
          : `GitHub checks concluded ${run.status.toLowerCase()}`,
    };
  });
}

function jiraKey(context: WorkflowExecutionContext): string {
  return text(
    context.node.config.issueKey ??
      getSessionValue(context.sessionData, "ticket.key"),
    "Jira issue key",
    100,
  );
}

function registerJiraAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  executor.register("JIRA_LOAD_TICKET", async (context) => {
    const ticket = await services.jira.ticket(
      jiraKey(context),
      context.node.config.force === true,
    );
    const normalized = normalizeTicket(ticket);
    return { output: normalized, sessionPatch: { ticket: normalized } };
  });
  executor.register("JIRA_TRANSITION", async (context) => {
    const ticket = await services.jira.transitionTicket(
      jiraKey(context),
      text(context.node.config.transitionId, "Jira transition ID", 200),
    );
    const normalized = normalizeTicket(ticket);
    return { output: normalized, sessionPatch: { ticket: normalized } };
  });
  executor.register("JIRA_COMMENT", async (context) => {
    const ticket = await services.jira.addComment(jiraKey(context), {
      value: text(context.node.config.content, "Jira comment", 100_000),
      format:
        context.node.config.format === "JIRA_WIKI" ? "JIRA_WIKI" : "MARKDOWN",
    });
    return { output: normalizeTicket(ticket) };
  });
  executor.register("JIRA_ASSIGN", async (context) => {
    const accountId =
      context.node.config.accountId === null
        ? null
        : text(context.node.config.accountId, "Jira account ID", 500);
    const ticket = await services.jira.assignTicket(
      jiraKey(context),
      accountId,
    );
    const normalized = normalizeTicket(ticket);
    return { output: normalized, sessionPatch: { ticket: normalized } };
  });
  executor.register("JIRA_UPDATE_FIELDS", async (context) => {
    const fields = object(context.node.config.fields ?? {}, "Jira fields");
    const ticket = await services.jira.updateTicket({
      issueKey: jiraKey(context),
      ...fields,
    } as Parameters<JiraService["updateTicket"]>[0]);
    const normalized = normalizeTicket(ticket);
    return { output: normalized, sessionPatch: { ticket: normalized } };
  });
  executor.register("JIRA_RESOLVE_BRANCH", async (context) => {
    const preview = await services.worktrees.previewTicketBranch({
      codebaseId: text(
        context.node.config.codebaseId ??
          getSessionValue(context.sessionData, "codebase.id"),
        "Codebase ID",
        200,
      ),
      worktreeId:
        typeof getSessionValue(context.sessionData, "worktree.id") === "string"
          ? String(getSessionValue(context.sessionData, "worktree.id"))
          : null,
      ticketKey: jiraKey(context),
    });
    return {
      output: preview,
      sessionPatch: {
        worktree: { branch: preview.branchName },
        ticket: {
          key: preview.ticketKey,
          title: preview.ticketTitle,
          type: preview.ticketType,
        },
      },
    };
  });
}

function pullRequestNumber(context: WorkflowExecutionContext): number {
  const value =
    context.node.config.number ??
    getSessionValue(context.sessionData, "pr.number");
  const result = typeof value === "string" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isInteger(result) || result < 1) {
    throw new Error("Pull request number is required");
  }
  return result;
}

function registerGitHubAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  executor.register("GITHUB_LOAD_PR", async (context) => {
    const repository = githubCoordinates(context);
    const pullRequest = await services.github.pullRequest(
      repository.owner,
      repository.name,
      pullRequestNumber(context),
    );
    if (!pullRequest) throw new Error("Pull request was not found");
    const normalized = normalizePullRequest(pullRequest);
    return {
      output: normalized,
      sessionPatch: { pr: normalized },
      links: [
        {
          kind: "PULL_REQUEST",
          resourceId: pullRequestResourceId(
            repository.owner,
            repository.name,
            pullRequest.number,
          ),
          label: pullRequest.title,
          url: pullRequest.url,
          metadata: { repository: pullRequest.repositoryNameWithOwner },
        },
      ],
    };
  });
  executor.register("GITHUB_MERGE_PR", async (context) => {
    const repository = githubCoordinates(context);
    const prNumber = pullRequestNumber(context);
    const options = await services.github.pullRequestMergeOptions(
      repository.owner,
      repository.name,
      prNumber,
    );
    if (!options.canMerge)
      throw new Error(options.blockedReason || "Pull request cannot be merged");
    const result = await services.github.mergePullRequest({
      ...repository,
      number: prNumber,
      method:
        context.node.config.method === "MERGE" ||
        context.node.config.method === "REBASE"
          ? context.node.config.method
          : "SQUASH",
      commitHeadline:
        typeof context.node.config.commitHeadline === "string"
          ? context.node.config.commitHeadline
          : options.defaultCommitHeadline,
      commitBody:
        typeof context.node.config.commitBody === "string"
          ? context.node.config.commitBody
          : options.defaultCommitBody,
      authorEmail:
        typeof context.node.config.authorEmail === "string"
          ? context.node.config.authorEmail
          : null,
    });
    return { output: result, sessionPatch: { pr: { state: result.state } } };
  });
  executor.register("GITHUB_COLLECT_REVIEW_THREADS", async (context) => {
    const repository = githubCoordinates(context);
    const pullRequest = await services.github.pullRequest(
      repository.owner,
      repository.name,
      pullRequestNumber(context),
    );
    if (!pullRequest) throw new Error("Pull request was not found");
    const unresolved = pullRequest.reviewThreads.filter(
      ({ isResolved }) => !isResolved,
    );
    return {
      output: unresolved,
      sessionPatch: { pr: { unresolvedThreads: unresolved } },
    };
  });
  executor.register("GITHUB_REPLY_REVIEW_THREAD", async (context) => {
    const result = await services.github.replyToReviewThread(
      text(context.node.config.threadId, "Review thread ID", 500),
      text(context.node.config.body, "Review reply", 100_000),
    );
    return { output: result };
  });
  executor.register("GITHUB_SET_REVIEW_THREAD_RESOLVED", async (context) => ({
    output: await services.github.setReviewThreadResolved(
      text(context.node.config.threadId, "Review thread ID", 500),
      context.node.config.resolved !== false,
    ),
  }));
  executor.register("GITHUB_CREATE_PR", async (context) => {
    const repository = githubCoordinates(context);
    const pullRequest = await services.github.createPullRequest({
      ...repository,
      baseRefName: text(
        context.node.config.baseRefName ??
          getSessionValue(context.sessionData, "worktree.baseBranch"),
        "Base branch",
        500,
      ),
      headRefName: text(
        context.node.config.headRefName ??
          getSessionValue(context.sessionData, "worktree.branch"),
        "Head branch",
        500,
      ),
      title: text(
        context.node.config.title ??
          getSessionValue(context.sessionData, "ticket.title"),
        "Pull request title",
        500,
      ),
      body:
        typeof context.node.config.body === "string"
          ? context.node.config.body
          : null,
      draft: context.node.config.draft === true,
    });
    const normalized = normalizePullRequest(pullRequest);
    return {
      output: normalized,
      sessionPatch: { pr: normalized },
      links: [
        {
          kind: "PULL_REQUEST",
          resourceId: pullRequestResourceId(
            repository.owner,
            repository.name,
            pullRequest.number,
          ),
          label: pullRequest.title,
          url: pullRequest.url,
        },
      ],
    };
  });
  executor.register("GITHUB_SET_PR_LABELS", async (context) => {
    const repository = githubCoordinates(context);
    const labels = Array.isArray(context.node.config.labels)
      ? context.node.config.labels.map(String)
      : [];
    const pullRequest = await services.github.setPullRequestLabels({
      ...repository,
      number: pullRequestNumber(context),
      labels,
    });
    return {
      output: pullRequest.labels,
      sessionPatch: { pr: { labels: pullRequest.labels } },
    };
  });
  executor.register("GITHUB_RETRY_PIPELINE", async (context) => {
    const result = await services.github.retryPipeline(
      text(
        context.node.config.repositoryId ??
          getSessionValue(context.sessionData, "pr.repositoryGithubId"),
        "GitHub repository ID",
        500,
      ),
      text(
        context.node.config.checkSuiteId ??
          getSessionValue(context.sessionData, "pipeline.checkSuiteId"),
        "Check suite ID",
        500,
      ),
      { actor: "workflow", ipAddress: null },
    );
    return {
      output: result,
      sessionPatch: { pipeline: { status: result.status } },
    };
  });
  executor.register("GITHUB_RETRY_JOB", async (context) => ({
    output: await services.github.retryWorkflowJob(
      text(context.node.config.repositoryId, "GitHub repository ID", 500),
      text(context.node.config.checkSuiteId, "Check suite ID", 500),
      text(context.node.config.jobId, "Workflow job ID", 500),
      { actor: "workflow", ipAddress: null },
    ),
  }));
  executor.register("GITHUB_CANCEL_WORKFLOW_RUN", async (context) => ({
    output: await services.github.cancelActionsWorkflowRun(
      text(
        context.node.config.codebaseRepositoryId ??
          getSessionValue(context.sessionData, "repo.id"),
        "Codebase repository ID",
        500,
      ),
      text(
        context.node.config.workflowRunId ??
          getSessionValue(context.sessionData, "pipeline.runId"),
        "Workflow run ID",
        500,
      ),
      context.node.config.force === true,
      { actor: "workflow", ipAddress: null },
    ),
    sessionPatch: { pipeline: { status: "CANCELLED" } },
  }));
  executor.register("GITHUB_SAVE_AUTO_RETRY", async (context) => ({
    output: await services.github.saveAutoRetryRule(
      object(context.node.config.input, "Auto-retry rule") as Parameters<
        GitHubService["saveAutoRetryRule"]
      >[0],
    ),
  }));
  executor.register("GITHUB_WAIT_CHECKS", async (context) => {
    const repositoryId = text(
      context.node.config.repositoryId ??
        getSessionValue(context.sessionData, "repo.id"),
      "Repository ID",
      500,
    );
    const workflowRunId = text(
      context.node.config.workflowRunId ??
        getSessionValue(context.sessionData, "pipeline.runId"),
      "Workflow run ID",
      500,
    );
    return {
      wait: {
        kind: "GITHUB_CHECKS",
        externalKey: JSON.stringify({ repositoryId, workflowRunId }),
        resumeAfter: new Date(Date.now() + 1_000),
        timeoutAt:
          typeof context.node.config.timeoutSeconds === "number"
            ? new Date(Date.now() + context.node.config.timeoutSeconds * 1_000)
            : null,
      },
    };
  });
}

function worktreeId(context: WorkflowExecutionContext): string {
  return configuredId(context, "worktreeId", "worktree.id", "Worktree ID");
}

/**
 * Older workflow versions could bind a worktree resource field to any session
 * path. If one was accidentally bound to `workflow.id`, resolution has already
 * replaced the binding by the time the adapter runs. Recover only that known
 * cross-resource mismatch; all other configured worktree overrides remain
 * authoritative.
 */
function runWorktreeId(context: WorkflowExecutionContext): string {
  const configured = context.node.config.worktreeId;
  const sessionWorktreeId = getSessionValue(context.sessionData, "worktree.id");
  if (
    typeof configured === "string" &&
    configured === context.run.workflowId &&
    typeof sessionWorktreeId === "string" &&
    sessionWorktreeId !== configured
  ) {
    return text(sessionWorktreeId, "Worktree ID", 500);
  }
  return worktreeId(context);
}

function codebaseId(context: WorkflowExecutionContext): string {
  return configuredId(context, "codebaseId", "codebase.id", "Codebase ID");
}

function branchSelection(context: WorkflowExecutionContext) {
  const mode = String(context.node.config.mode ?? "NEW").toUpperCase();
  if (!new Set(["NEW", "EXISTING", "TICKET"]).has(mode)) {
    throw new Error("Worktree branch mode must be NEW, EXISTING, or TICKET");
  }
  return {
    mode: mode as "NEW" | "EXISTING" | "TICKET",
    branchName:
      mode === "TICKET"
        ? null
        : optionalText(
            context.node.config.branchName ??
              getSessionValue(context.sessionData, "worktree.branch"),
            500,
          ),
    ticketKey:
      mode === "TICKET"
        ? optionalText(
            context.node.config.ticketKey ??
              getSessionValue(context.sessionData, "ticket.key"),
            100,
          )
        : null,
    baseBranch: text(
      context.node.config.baseBranch ??
        getSessionValue(context.sessionData, "worktree.baseBranch") ??
        getSessionValue(context.sessionData, "repo.defaultBranch"),
      "Base branch",
      500,
    ),
  };
}

function registerWorktreeAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  executor.register("WORKTREE_CREATE", async (context) => {
    const selection = branchSelection(context);
    const job = await services.worktrees.createWorktree({
      codebaseId: codebaseId(context),
      selection,
      requestId: requestId(context, "create"),
    });
    return jobResult(job, {
      worktree: {
        branch: selection.branchName,
        baseBranch: selection.baseBranch,
      },
    });
  });
  executor.register("WORKTREE_CHANGE_BRANCH", async (context) => {
    const selection = branchSelection(context);
    const job = await services.worktrees.changeWorktreeBranch({
      worktreeId: worktreeId(context),
      selection,
      requestId: requestId(context, "change-branch"),
      stashOnFailure: context.node.config.stashOnFailure === true,
    });
    return jobResult(job, {
      worktree: {
        branch: selection.branchName,
        baseBranch: selection.baseBranch,
      },
    });
  });
  executor.register("WORKTREE_OPERATION", async (context) => {
    const operation = String(
      context.node.config.operation ?? "SYNC",
    ).toUpperCase();
    if (
      operation === "OPEN_EDITOR" ||
      !WORKTREE_OPERATIONS.includes(operation as WorktreeOperation)
    ) {
      throw new Error("Worktree operation is invalid for workflow execution");
    }
    const job = await services.worktrees.runOperation(
      worktreeId(context),
      operation as WorktreeOperation,
      requestId(context, operation.toLowerCase()),
    );
    return jobResult(job);
  });
  executor.register("WORKTREE_DELETE", async (context) => {
    const job = await services.worktrees.deleteWorktree({
      worktreeId: worktreeId(context),
      deleteRemoteBranch: context.node.config.deleteRemoteBranch === true,
      requestId: requestId(context, "delete"),
    });
    return jobResult(job);
  });
  executor.register("WORKTREE_MOVE", async (context) => {
    const move = await services.worktrees.moveWorktree({
      sourceWorktreeId: worktreeId(context),
      targetCodebaseId: text(
        context.node.config.targetCodebaseId,
        "Target codebase ID",
        500,
      ),
      targetWorktreeId: optionalText(context.node.config.targetWorktreeId, 500),
      deleteSource: context.node.config.deleteSource === true,
      requestId: requestId(context, "move"),
    });
    return {
      output: move,
      links: [
        {
          kind: "WORKTREE_MOVE",
          resourceId: move.id,
          label: "Worktree move",
        },
      ],
      wait: {
        kind: "WORKTREE_MOVE",
        externalKey: move.id,
        resumeAfter: new Date(Date.now() + 1_000),
      },
    };
  });
  executor.register("WORKTREE_INSPECT", async (context) => {
    const id = worktreeId(context);
    const detail = await services.worktrees.inspect(
      id,
      requestId(context, "inspect"),
    );
    return {
      output: detail,
      sessionPatch: {
        worktree: {
          commits: (detail as unknown as Record<string, unknown>).commits,
          changes: detail.changes,
          branchChanges: detail.branchChanges,
        },
      },
    };
  });
  executor.register("WORKTREE_INSPECT_GIT", async (context) => {
    const state = await services.worktrees.inspectGitState(
      worktreeId(context),
      requestId(context, "inspect-git"),
    );
    return {
      output: state,
      sessionPatch: { worktree: { ...state } },
    };
  });
  executor.register("WORKTREE_GIT_OPERATION", async (context) => {
    const operation = String(
      context.node.config.operation ?? "PULL_BRANCH",
    ).toUpperCase();
    if (!WORKTREE_GIT_OPERATIONS.includes(operation as WorktreeGitOperation)) {
      throw new Error("Worktree Git operation is invalid");
    }
    const job = await services.worktrees.runGitOperation({
      worktreeId: worktreeId(context),
      operation: operation as WorktreeGitOperation,
      branch: optionalText(context.node.config.branch, 500),
      stashOid: optionalText(context.node.config.stashOid, 200),
      stashChanges: context.node.config.stashChanges === true,
      requestId: requestId(context, operation.toLowerCase()),
    });
    return jobResult(job);
  });
  executor.register("WORKTREE_WAIT_PUSH_READY", async (context) => ({
    wait: {
      kind: "WORKTREE_PUSH_READY",
      externalKey: worktreeId(context),
      resumeAfter: new Date(Date.now() + 1_000),
      timeoutAt:
        typeof context.node.config.timeoutSeconds === "number"
          ? new Date(Date.now() + context.node.config.timeoutSeconds * 1_000)
          : null,
    },
  }));
}

function registerCodebaseAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  executor.register("CODEBASE_FETCH_REFRESH", async (context) => {
    const kind =
      context.node.config.operation === "REFRESH"
        ? CODEBASE_REFRESH_JOB_KIND
        : CODEBASE_FETCH_JOB_KIND;
    const result = await services.codebases.runOperation(
      kind,
      [codebaseId(context)],
      requestId(context, kind),
    );
    const job = result.jobs[0];
    if (!job) {
      throw new Error(
        result.skipped[0]?.reason ?? "Codebase operation was skipped",
      );
    }
    return jobResult(job);
  });
  executor.register("CODEBASE_INSPECT_GIT", async (context) => {
    const state = await services.codebases.inspectGitState(
      codebaseId(context),
      requestId(context, "inspect-git"),
    );
    return {
      output: state,
      sessionPatch: { codebase: { ...state } },
    };
  });
  executor.register("CODEBASE_GIT_OPERATION", async (context) => {
    const operation = String(
      context.node.config.operation ?? "PULL_BRANCH",
    ).toUpperCase();
    if (!CODEBASE_GIT_OPERATIONS.includes(operation as CodebaseGitOperation)) {
      throw new Error("Codebase Git operation is invalid");
    }
    const job = await services.codebases.runGitOperation({
      codebaseId: codebaseId(context),
      operation: operation as CodebaseGitOperation,
      branch: optionalText(context.node.config.branch, 500),
      stashOid: optionalText(context.node.config.stashOid, 200),
      stashChanges: context.node.config.stashChanges === true,
      requestId: requestId(context, operation.toLowerCase()),
    });
    return jobResult(job);
  });
}

function buildId(context: WorkflowExecutionContext): string {
  return configuredId(context, "buildId", "build.id", "Build ID");
}

function registerBuildAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  executor.register("BUILD_START", async (context) => {
    const action = String(context.node.config.action ?? "BUILD").toUpperCase();
    if (!BUILD_ACTIONS.includes(action as BuildAction)) {
      throw new Error("Build action is invalid");
    }
    const build = await services.builds.startBuild({
      worktreeId: worktreeId(context),
      configurationId: text(
        context.node.config.configurationId,
        "Build configuration ID",
        500,
      ),
      destination: context.node.config.destination,
      scriptIds: Array.isArray(context.node.config.scriptIds)
        ? context.node.config.scriptIds.map(String)
        : [],
      action: action as BuildAction,
      advancedSettings: context.node.config.advancedSettings,
      exportWhenComplete: context.node.config.exportWhenComplete === true,
      exportSettings: context.node.config.exportSettings,
      worktreeCoverage: context.node.config.worktreeCoverage === true,
      requestId: requestId(context, "build"),
      telemetryRequestOrigin: "workflow",
    });
    return {
      output: build,
      sessionPatch: {
        build: { id: build.id, status: build.status, action: build.action },
      },
      links: [
        {
          kind: "BUILD",
          resourceId: build.id,
          label: `${build.action} build`,
          url: `/builds/${build.id}`,
        },
      ],
      wait: {
        kind: "BUILD",
        externalKey: build.id,
        resumeAfter: new Date(Date.now() + 1_000),
      },
    };
  });
  executor.register("BUILD_READ_TEST_RESULTS", async (context) => {
    const report = (await services.builds.reportsForBuild(buildId(context)))
      .filter(
        ({ kind, status }) => kind === "TEST_RESULTS" && status === "READY",
      )
      .at(-1);
    if (!report) throw new Error("Test results are not ready");
    const summary = object(JSON.parse(report.summaryJson), "Test summary");
    const data = object(JSON.parse(report.dataJson), "Test results");
    return {
      output: { summary, tests: data.tests ?? [] },
      sessionPatch: {
        build: { testSummary: summary, tests: data.tests ?? [] },
      },
    };
  });
  executor.register("BUILD_READ_COVERAGE", async (context) => {
    const report = (await services.builds.reportsForBuild(buildId(context)))
      .filter(
        ({ kind, status }) => kind === "CODE_COVERAGE" && status === "READY",
      )
      .at(-1);
    if (!report) throw new Error("Coverage results are not ready");
    const summary = object(JSON.parse(report.summaryJson), "Coverage summary");
    const data = object(JSON.parse(report.dataJson), "Coverage results");
    return {
      output: {
        summary,
        files: data.files ?? [],
        changedFiles: data.changedFiles ?? [],
      },
      sessionPatch: {
        build: {
          coverageSummary: summary,
          coverageFiles: data.files ?? [],
          changedCoverageFiles: data.changedFiles ?? [],
        },
      },
    };
  });
  executor.register("BUILD_EXPORT", async (context) => {
    const result = await services.builds.exportArchive({
      buildId: buildId(context),
      requestId: requestId(context, "export"),
      settings: object(context.node.config.settings, "Export settings"),
    });
    return result.jobId
      ? jobResult(
          { id: result.jobId, timeoutSeconds: 3_600 },
          {
            build: { exportId: result.id },
          },
        )
      : { output: result };
  });
  executor.register("BUILD_DEPLOY", async (context) => {
    const deployments = await services.builds.runBuild({
      buildId: buildId(context),
      destinations: Array.isArray(context.node.config.destinations)
        ? context.node.config.destinations
        : [],
      requestId: requestId(context, "deploy"),
    });
    const jobId = deployments.find(({ jobId }) => Boolean(jobId))?.jobId;
    return jobId
      ? jobResult({ id: jobId, timeoutSeconds: 3_600 })
      : { output: deployments };
  });
  executor.register("BUILD_CANCEL", async (context) => {
    const build = await services.builds.cancelBuild(buildId(context));
    return {
      output: build,
      sessionPatch: { build: { id: build?.id, status: build?.status } },
    };
  });
}

function agentRunId(context: WorkflowExecutionContext): string {
  const configured = context.node.config.runId;
  if (typeof configured === "string" && configured) return configured;
  const sourceStepId = context.node.config.sourceStepId;
  if (typeof sourceStepId === "string") {
    return text(
      getSessionValue(context.sessionData, `run.${sourceStepId}.id`),
      "Agent run ID",
      500,
    );
  }
  return text(
    getSessionValue(context.sessionData, "run.id"),
    "Agent run ID",
    500,
  );
}

function createRunInput(
  context: WorkflowExecutionContext,
  kind: "PLAN" | "SESSION",
): RunConfigurationInput {
  return {
    kind,
    worktreeId: runWorktreeId(context),
    jiraIssueKey: optionalText(
      context.node.config.jiraIssueKey ??
        getSessionValue(context.sessionData, "ticket.key"),
      100,
    ),
    provider: text(context.node.config.provider ?? "CODEX", "Provider", 50),
    model: text(context.node.config.model, "Model", 200),
    effort: optionalText(context.node.config.effort, 50),
    webSearchEnabled: context.node.config.webSearchEnabled === true,
    prompt: text(context.node.config.prompt, "Prompt", 200_000),
    attachmentIds: Array.isArray(context.node.config.attachmentIds)
      ? context.node.config.attachmentIds.map(String)
      : [],
  };
}

function registerRunAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  executor.register("RUN_CREATE_PLAN", async (context) => {
    const run = await services.runs.create(createRunInput(context, "PLAN"));
    if (!run) throw new Error("Plan could not be created");
    return runResult(context, run as unknown as Record<string, unknown>, true);
  });
  executor.register("RUN_CREATE_SESSION", async (context) => {
    const run = await services.runs.create(createRunInput(context, "SESSION"));
    if (!run) throw new Error("Session could not be created");
    return runResult(context, run as unknown as Record<string, unknown>, true);
  });
  executor.register("RUN_PLAY_PLAN", async (context) => {
    const run = await services.runs.playPlan(agentRunId(context));
    if (!run) throw new Error("Plan could not be played");
    return runResult(context, run as unknown as Record<string, unknown>, true);
  });
  executor.register("RUN_FOLLOW_UP", async (context) => {
    const input = createRunInput(context, "SESSION");
    const run = await services.runs.followUp(agentRunId(context), {
      ...input,
      followUpMode: text(
        context.node.config.followUpMode ?? "RESUME",
        "Follow-up mode",
        50,
      ),
      contextMode: optionalText(context.node.config.contextMode, 50),
    });
    if (!run) throw new Error("Follow-up could not be created");
    return runResult(context, run as unknown as Record<string, unknown>, true);
  });
  executor.register("RUN_STEER", async (context) => {
    const run = await services.runs.steer(
      agentRunId(context),
      text(context.node.config.prompt, "Steering prompt", 200_000),
      Array.isArray(context.node.config.attachmentIds)
        ? context.node.config.attachmentIds.map(String)
        : [],
    );
    if (!run) throw new Error("Run could not be steered");
    return runResult(context, run as unknown as Record<string, unknown>);
  });
  executor.register("RUN_ANSWER", async (context) => {
    const run = await services.runs.answerQuestion(
      text(context.node.config.batchId, "Question batch ID", 500),
      context.node.config.answers ?? {},
    );
    if (!run) throw new Error("Question could not be answered");
    return runResult(context, run as unknown as Record<string, unknown>);
  });
  for (const [kind, lifecycle] of [
    ["RUN_PAUSE", "PAUSE"],
    ["RUN_CONTINUE", "CONTINUE"],
    ["RUN_CANCEL", "CANCEL"],
  ] as const) {
    executor.register(kind, async (context) => {
      const run = await services.runs.lifecycle(agentRunId(context), lifecycle);
      if (!run) throw new Error("Run lifecycle operation failed");
      return runResult(context, run as unknown as Record<string, unknown>);
    });
  }
  executor.register("RUN_REVISE_ANSWER", async (context) => {
    const batchId = text(context.node.config.batchId, "Question batch ID", 500);
    const batch = await services.runs.questionBatch(batchId);
    if (!batch) throw new Error("Question batch was not found");
    if (batch.revisionPreparedAt) {
      const run = await services.runs.reviseAnswer(
        batchId,
        context.node.config.answers ?? {},
        context.node.config.stash === true,
        context.node.config.rollback !== false,
      );
      if (!run) throw new Error("Answer revision failed");
      return runResult(context, run as unknown as Record<string, unknown>);
    }
    await services.runs.prepareAnswerRevision(batchId);
    return {
      wait: {
        kind: "RUN_ANSWER_REVISION",
        externalKey: JSON.stringify({
          batchId,
          answers: context.node.config.answers ?? {},
          stash: context.node.config.stash === true,
          rollback: context.node.config.rollback !== false,
        }),
        resumeAfter: new Date(Date.now() + 1_000),
      },
    };
  });
  executor.register("RUN_READ_RESULT", async (context) => {
    const run = await services.runs.get(agentRunId(context));
    if (!run) throw new Error("Run was not found");
    const [events, questions, usage, links] = await Promise.all([
      services.runs.events({ runId: run.id, first: 500 }),
      services.runs.questions({ runId: run.id, first: 200 }),
      services.runs.usage(run.id),
      services.runs.linkedItems(run.id),
    ]);
    return runResult(context, {
      ...(run as unknown as Record<string, unknown>),
      events,
      questions,
      usage,
      links,
    });
  });
  executor.register("RUN_CAPTURE_CHECKPOINT", async (context) => {
    const prisma = await getPrismaClient();
    const checkpoint = await prisma.runCheckpoint.findFirst({
      where: { runId: agentRunId(context) },
      orderBy: { createdAt: "desc" },
    });
    if (!checkpoint) throw new Error("Run has no captured checkpoint");
    return {
      output: checkpoint,
      sessionPatch: {
        steps: { [context.node.id]: { snapshotId: checkpoint.id } },
      },
      links: [
        {
          kind: "CHECKPOINT",
          resourceId: checkpoint.id,
          label: `${checkpoint.kind} checkpoint`,
        },
      ],
    };
  });
  executor.register("RUN_ARCHIVE_DELETE", async (context) => {
    const id = agentRunId(context);
    const affected =
      context.node.config.delete === true
        ? await services.runs.deleteRuns([id])
        : await services.runs.archive(
            [id],
            context.node.config.archived !== false,
          );
    return { output: { id, affected } };
  });
}

function registerMiscellaneousAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  executor.register("SKILL_APPLY", async (context) => {
    const run = await services.skills.prepareSync(
      context.node.config.groupId ? "GROUP" : "ALL",
      optionalText(context.node.config.groupId, 500),
      false,
    );
    if (!run) throw new Error("Skill sync could not be prepared");
    return {
      output: run,
      links: [{ kind: "SKILL_RUN", resourceId: run.id, label: "Skill sync" }],
      wait: {
        kind: "SKILL_RUN",
        externalKey: run.id,
        resumeAfter: new Date(Date.now() + 1_000),
      },
    };
  });
  executor.register("NOTIFICATION_SEND", async (context) => {
    const prisma = await getPrismaClient();
    const notification = await prisma.$transaction((transaction) =>
      services.notifications.recordInTransaction(transaction, {
        dedupeKey: `${context.run.id}:${context.node.id}:${context.attempt.generation}`,
        typeKey: "WORKFLOW_MESSAGE",
        title: text(context.node.config.title, "Notification title", 240),
        body: text(context.node.config.body, "Notification body", 1_000),
        href:
          typeof context.node.config.href === "string"
            ? context.node.config.href
            : `/workflows/runs/${context.run.id}`,
        resourceKind: "WORKFLOW_RUN",
        resourceId: context.run.id,
        worktreeId:
          typeof getSessionValue(context.sessionData, "worktree.id") ===
          "string"
            ? String(getSessionValue(context.sessionData, "worktree.id"))
            : null,
      }),
    );
    services.notifications.created(notification);
    return { output: notification };
  });
  executor.register("IOS_PUSH_SEND", async (context) => ({
    output: await services.pushNotifications.send({
      requestId: requestId(context, "ios-push"),
      editor: context.node.config.editor,
      targetMode: text(
        context.node.config.targetMode ?? "ALL",
        "Push target mode",
        50,
      ),
      registrationIds: Array.isArray(context.node.config.registrationIds)
        ? context.node.config.registrationIds.map(String)
        : [],
      channelId: optionalText(context.node.config.channelId, 500),
      directToken: optionalText(context.node.config.directToken, 20_000),
      directTokenEncoding:
        context.node.config.directTokenEncoding === "BASE64" ? "BASE64" : "HEX",
      directEnvironment:
        context.node.config.directEnvironment === "PRODUCTION"
          ? "PRODUCTION"
          : "SANDBOX",
    }),
  }));
  executor.register("MCP_CALL", async (context) => {
    const result = await services.tools.callTool({
      groupId: text(context.node.config.groupId, "MCP tool group", 500),
      name: text(context.node.config.name, "MCP tool name", 500),
      arguments: object(context.node.config.arguments ?? {}, "MCP arguments"),
    });
    return {
      output: result,
      sessionPatch: { steps: { [context.node.id]: { output: result } } },
    };
  });
}
