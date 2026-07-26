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
import type { BuildDataService } from "@/services/build-data";
import type { CcusageService } from "@/services/ccusage";
import type { CodebasesService } from "@/services/codebases";
import type { CommandsService } from "@/services/commands";
import type { DiskSpaceService } from "@/services/disk-space";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import type { NotificationsService } from "@/services/notifications";
import type { IosDevicesService } from "@/services/ios-devices";
import type { ModelCostsService } from "@/services/model-costs";
import type { PushNotificationsService } from "@/services/push-notifications";
import type { RunsService } from "@/services/runs";
import type { SkillsService } from "@/services/skills";
import type { SigningAssetsService } from "@/services/signing-assets";
import type { ToolsService } from "@/services/tools";
import type {
  WorktreeAutomationService,
  WorktreesService,
} from "@/services/worktrees";
import type { RunConfigurationInput } from "@/services/runs";
import { pullRequestResourceId } from "@/lib/workflows/resources";
import { getSessionValue } from "@/lib/workflows/session";
import { waitResumeAfter, waitTimeoutAt } from "@/lib/workflows/wait-timing";
import type {
  WorkflowExecutionContext,
  WorkflowExecutionResult,
  WorkflowResourceLinkInput,
  WorkflowStepExecutor,
} from "./step-executor";
import type { WorkflowsService } from "./workflows.service";

export type WorkflowAdapterServices = {
  agentControl: AgentControlService;
  jira: JiraService;
  github: GitHubService;
  worktrees: WorktreesService;
  worktreeAutomations: WorktreeAutomationService;
  codebases: CodebasesService;
  builds: BuildsService;
  skills: SkillsService;
  runs: RunsService;
  notifications: NotificationsService;
  pushNotifications: PushNotificationsService;
  tools: ToolsService;
  commands: CommandsService;
  diskSpace: DiskSpaceService;
  buildData: BuildDataService;
  ccusage: CcusageService;
  iosDevices: IosDevicesService;
  modelCosts: ModelCostsService;
  signingAssets: SigningAssetsService;
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
            metadata: { runKind: run.kind },
          },
        ]
      : undefined,
  wait:
    wait && typeof run.id === "string"
      ? {
          kind: "AGENT_RUN",
          externalKey: run.id,
          resumeAfter: waitResumeAfter(context.node.config),
          timeoutAt: waitTimeoutAt(context.node.config),
        }
      : undefined,
});

const jobResult = (
  context: WorkflowExecutionContext,
  job: { id: string; timeoutSeconds?: number | null },
  sessionPatch?: Record<string, unknown>,
  resourceLinks: WorkflowResourceLinkInput[] = [],
): WorkflowExecutionResult => ({
  output: { jobId: job.id },
  sessionPatch,
  links: [
    ...resourceLinks,
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
    resumeAfter: waitResumeAfter(context.node.config),
    // The agent job carries its own budget; a configured timeout overrides it.
    timeoutAt: waitTimeoutAt(context.node.config, job.timeoutSeconds ?? 3_600),
  },
});

const detailLink = (
  kind: string,
  resourceId: string,
  label?: string,
  url?: string,
  metadata?: Record<string, unknown>,
): WorkflowResourceLinkInput => ({
  kind,
  resourceId,
  label,
  url,
  metadata,
});

const jiraLink = (issueKey: string, label?: string) =>
  detailLink("JIRA_TICKET", issueKey, label ?? issueKey);
const worktreeLink = (id: string) => detailLink("WORKTREE", id, "Worktree");
const codebaseLink = (id: string) => detailLink("CODEBASE", id, "Codebase");
const buildLink = (id: string, url?: string) =>
  detailLink("BUILD", id, "Build", url);

function pullRequestLink(
  context: WorkflowExecutionContext,
  label?: string,
  providerUrl?: string,
): WorkflowResourceLinkInput {
  const repository = githubCoordinates(context);
  return detailLink(
    "PULL_REQUEST",
    pullRequestResourceId(
      repository.owner,
      repository.name,
      pullRequestNumber(context),
    ),
    label ?? "Pull request",
    providerUrl,
  );
}

function contextualPullRequestLink(
  context: WorkflowExecutionContext,
): WorkflowResourceLinkInput | null {
  const repository = contextualGitHubCoordinates(context);
  const number = contextualPullRequestNumber(context);
  return repository && number
    ? detailLink(
        "PULL_REQUEST",
        pullRequestResourceId(repository.owner, repository.name, number),
        "Pull request",
      )
    : null;
}

function githubWorkflowRunLink(
  context: WorkflowExecutionContext,
): WorkflowResourceLinkInput | null {
  const id =
    context.node.config.workflowRunId ??
    getSessionValue(context.sessionData, "pipeline.runId");
  const url = getSessionValue(context.sessionData, "pipeline.url");
  return (typeof id === "string" || typeof id === "number") &&
    typeof url === "string" &&
    url
    ? detailLink("GITHUB_WORKFLOW_RUN", String(id), "Workflow run", url)
    : null;
}

function contextualAgentRunLink(
  context: WorkflowExecutionContext,
): WorkflowResourceLinkInput | null {
  const kind = getSessionValue(context.sessionData, "run.kind");
  if (kind !== "PLAN" && kind !== "SESSION") return null;
  const id = contextualAgentRunId(context);
  if (!id) return null;
  return detailLink(
    "AGENT_RUN",
    id,
    kind,
    `/${kind === "PLAN" ? "plans" : "sessions"}/${id}`,
    { runKind: kind },
  );
}

function contextualGitHubCoordinates(context: WorkflowExecutionContext): {
  owner: string;
  name: string;
} | null {
  const owner = context.node.config.owner;
  const name = context.node.config.name;
  if (
    typeof owner === "string" &&
    owner.trim() &&
    typeof name === "string" &&
    name.trim()
  ) {
    return { owner: owner.trim(), name: name.trim() };
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
  const matchedOwner = match?.[1]?.trim();
  const matchedName = match?.[2]?.trim();
  return matchedOwner && matchedName
    ? { owner: matchedOwner, name: matchedName }
    : null;
}

function githubCoordinates(context: WorkflowExecutionContext): {
  owner: string;
  name: string;
} {
  const repository = contextualGitHubCoordinates(context);
  if (!repository) throw new Error("GitHub owner and repository are required");
  return repository;
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
    headBranch: pullRequest.headRefName,
    headSha: pullRequest.headRefOid,
    merged: pullRequest.state === "MERGED",
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
  registerDiskSpaceAdapters(executor, services);
  registerRunAdapters(executor, services);
  registerMiscellaneousAdapters(executor, services);
  registerExpansionAdapters(executor, services);
}

function registerExpansionAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  const workflowContext = (context: WorkflowExecutionContext) => ({
    caller: `workflow:${context.run.id}`,
    correlationId: context.attempt.id,
    source: "WORKFLOW" as const,
  });
  const call = async (
    context: WorkflowExecutionContext,
    groupId: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const output = await services.tools.callTool(
      { groupId, name, arguments: args },
      workflowContext(context),
    );
    return {
      output,
      sessionPatch: { steps: { [context.node.id]: { output } } },
    };
  };
  const contextual = (
    context: WorkflowExecutionContext,
    configKey: string,
    sessionPath: string,
    label: string,
  ) => configuredId(context, configKey, sessionPath, label);

  executor.register("COMMAND_RERUN", (context) =>
    call(context, "builtin:commands", "rerun_command", {
      id: contextual(context, "commandRunId", "command.id", "Command run ID"),
    }),
  );
  executor.register("COMMAND_TERMINATE", (context) =>
    call(context, "builtin:commands", "terminate_command_run", {
      id: contextual(context, "commandRunId", "command.id", "Command run ID"),
    }),
  );
  executor.register("COMMAND_READ_OUTPUT", (context) =>
    call(context, "builtin:commands", "get_command_run_output", {
      runId: contextual(
        context,
        "commandRunId",
        "command.id",
        "Command run ID",
      ),
      first: Number(context.node.config.first ?? 1000),
    }),
  );
  executor.register("WORKTREE_INSPECT_DIFF", (context) =>
    call(context, "builtin:worktrees", "inspect_worktree_diff", {
      worktreeId: contextual(
        context,
        "worktreeId",
        "worktree.id",
        "Worktree ID",
      ),
      scope: text(context.node.config.scope, "Diff scope", 100),
      path: context.node.config.path,
      previousPath: context.node.config.previousPath,
      commitSha: context.node.config.commitSha,
      requestId: requestId(context, "diff"),
    }),
  );
  executor.register("WORKTREE_UPDATE_METADATA", (context) =>
    call(context, "builtin:worktrees", "update_worktree_metadata", {
      id: contextual(context, "worktreeId", "worktree.id", "Worktree ID"),
      baseBranch: context.node.config.baseBranch,
      highlightColor: context.node.config.highlightColor,
    }),
  );
  executor.register("WORKTREE_MOVE_CONTROL", (context) =>
    call(
      context,
      "builtin:worktrees",
      context.node.config.operation === "CANCEL"
        ? "cancel_worktree_move"
        : "retry_worktree_move_with_stash",
      { id: text(context.node.config.moveId, "Move ID", 500) },
    ),
  );
  executor.register("BUILD_REBUILD", (context) =>
    call(context, "builtin:builds", "rebuild_build", {
      buildId: contextual(context, "buildId", "build.id", "Build ID"),
      requestId: requestId(context, "rebuild"),
    }),
  );
  executor.register("BUILD_GENERATE_REPORT", (context) =>
    call(context, "builtin:builds", "generate_build_report", {
      buildId: contextual(context, "buildId", "build.id", "Build ID"),
      kind:
        context.node.config.reportKind === "TEST_RESULTS"
          ? "TEST_RESULTS"
          : "CODE_COVERAGE",
      requestId: requestId(context, "report"),
    }),
  );
  executor.register("BUILD_DELETE", (context) =>
    call(context, "builtin:builds", "delete_builds", {
      ids: Array.isArray(context.node.config.buildIds)
        ? context.node.config.buildIds.map(String)
        : [contextual(context, "buildId", "build.id", "Build ID")],
    }),
  );
  executor.register("SKILL_PREPARE_SYNC", (context) =>
    call(context, "builtin:skills", "prepare_skill_sync", {
      kind: String(context.node.config.syncKind ?? "ALL"),
      groupId: context.node.config.groupId,
    }),
  );
  executor.register("SKILL_RESOLVE_SYNC", (context) =>
    call(context, "builtin:skills", "resolve_skill_sync_conflict", {
      input: {
        runId: contextual(
          context,
          "runId",
          "skillSync.id",
          "Skill sync run ID",
        ),
        itemId: text(context.node.config.itemId, "Conflict item ID", 500),
        resolution: String(context.node.config.resolution ?? "SKIP"),
      },
    }),
  );
  executor.register("SKILL_SKIP_SYNC", (context) =>
    call(context, "builtin:skills", "skip_skill_sync", {
      runId: contextual(context, "runId", "skillSync.id", "Skill sync run ID"),
    }),
  );
  executor.register("BUILD_DATA_REFRESH", (context) =>
    call(context, "builtin:build-data", "refresh_build_data", {
      requestId: requestId(context, "build-data"),
    }),
  );
  executor.register("BUILD_DATA_DELETE", (context) =>
    call(context, "builtin:build-data", "delete_build_data_entries", {
      collectionId: contextual(
        context,
        "collectionId",
        "buildData.id",
        "Build-data collection ID",
      ),
      entryIds: Array.isArray(context.node.config.entryIds)
        ? context.node.config.entryIds.map(String)
        : [],
      requestId: requestId(context, "build-data-delete"),
      overrideProtection: context.node.config.overrideProtection === true,
    }),
  );
  executor.register("BUILD_DATA_SET_LOCK", (context) =>
    call(context, "builtin:build-data", "set_build_data_lock", {
      collectionId: contextual(
        context,
        "collectionId",
        "buildData.id",
        "Build-data collection ID",
      ),
      entryId: text(context.node.config.entryId, "Entry ID", 500),
      locked: context.node.config.locked === true,
    }),
  );
  executor.register("SIGNING_REFRESH", (context) =>
    call(context, "builtin:signing-assets", "refresh_signing_assets", {
      agentIds: Array.isArray(context.node.config.agentIds)
        ? context.node.config.agentIds.map(String)
        : undefined,
    }),
  );
  executor.register("SIGNING_SYNC_PROFILE", (context) =>
    call(context, "builtin:signing-assets", "sync_signing_profile", {
      uuid: contextual(context, "uuid", "signingProfile.id", "Profile UUID"),
      sourceAgentId: text(
        context.node.config.sourceAgentId,
        "Source agent ID",
        500,
      ),
      targetAgentIds: Array.isArray(context.node.config.targetAgentIds)
        ? context.node.config.targetAgentIds.map(String)
        : [],
    }),
  );
  executor.register("SIGNING_DELETE_EXPIRED", (context) =>
    call(context, "builtin:signing-assets", "delete_expired_signing_profiles", {
      agentIds: Array.isArray(context.node.config.agentIds)
        ? context.node.config.agentIds.map(String)
        : undefined,
    }),
  );
  executor.register("IOS_DEVICE_REGISTER", (context) =>
    call(context, "builtin:ios-devices", "register_ios_device", {
      id: contextual(context, "deviceId", "device.id", "Device ID"),
    }),
  );
  executor.register("IOS_DEVICE_REJECT", (context) =>
    call(context, "builtin:ios-devices", "reject_ios_device", {
      id: contextual(context, "deviceId", "device.id", "Device ID"),
    }),
  );
  executor.register("AGENT_RECONCILE", async (context) => {
    const agentIds = Array.isArray(context.node.config.agentIds)
      ? context.node.config.agentIds.map(String)
      : (await services.agentControl.listAgents()).map(({ id }) => id);
    return {
      output: {
        requested:
          await services.agentControl.requestCodebaseReconcile(agentIds),
      },
    };
  });
  executor.register("AGENT_UPDATE_CADENCE", async (context) => ({
    output: await services.agentControl.updateCadenceSettings(
      contextual(context, "agentId", "agent.id", "Agent ID"),
      object(context.node.config.settings, "Cadence settings") as never,
    ),
  }));
  executor.register("CCUSAGE_COLLECT", async (context) => ({
    output: await services.ccusage.collect(requestId(context, "ccusage")),
  }));
  executor.register("MODEL_COST_REFRESH", async () => ({
    output: await services.modelCosts.refresh(),
  }));
  const githubPullRequestAction = async (
    context: WorkflowExecutionContext,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await call(context, "builtin:github", name, args);
    const output = object(result.output, "GitHub tool output");
    return {
      ...result,
      sessionPatch: {
        ...result.sessionPatch,
        pr: object(output.pullRequest, "Pull request output"),
      },
    };
  };
  const repositoryPullRequestConfig = (context: WorkflowExecutionContext) => ({
    owner: text(
      context.node.config.owner ??
        getSessionValue(context.sessionData, "repo.owner"),
      "Repository owner",
      200,
    ),
    name: text(
      context.node.config.name ??
        getSessionValue(context.sessionData, "repo.name"),
      "Repository name",
      200,
    ),
    number: Number(
      context.node.config.number ??
        getSessionValue(context.sessionData, "pr.number"),
    ),
  });
  executor.register("GITHUB_UPDATE_PR", (context) =>
    githubPullRequestAction(context, "update_pull_request", {
      ...repositoryPullRequestConfig(context),
      title: optionalText(context.node.config.title),
      body:
        typeof context.node.config.body === "string"
          ? context.node.config.body
          : undefined,
      draft:
        typeof context.node.config.draft === "boolean"
          ? context.node.config.draft
          : undefined,
    }),
  );
  executor.register("GITHUB_SUBMIT_REVIEW", (context) =>
    githubPullRequestAction(context, "submit_pull_request_review", {
      ...repositoryPullRequestConfig(context),
      event: String(context.node.config.event ?? "COMMENT"),
      body:
        typeof context.node.config.body === "string"
          ? context.node.config.body
          : undefined,
    }),
  );
  executor.register("GITHUB_REQUEST_REVIEWERS", (context) =>
    githubPullRequestAction(context, "request_pull_request_reviewers", {
      ...repositoryPullRequestConfig(context),
      reviewers: Array.isArray(context.node.config.reviewers)
        ? context.node.config.reviewers.map(String)
        : [],
      teamReviewers: Array.isArray(context.node.config.teamReviewers)
        ? context.node.config.teamReviewers.map(String)
        : [],
    }),
  );
  executor.register("GITHUB_DISPATCH_WORKFLOW", (context) =>
    call(context, "builtin:github", "dispatch_github_workflow", {
      repositoryId: contextual(
        context,
        "repositoryId",
        "repo.id",
        "Repository ID",
      ),
      workflowId: text(context.node.config.workflowId, "Workflow ID", 500),
      ref: text(context.node.config.ref, "Git ref", 500),
      inputs: context.node.config.inputs
        ? object(context.node.config.inputs, "Workflow inputs")
        : undefined,
    }),
  );

  const jiraTicketAction = async (
    context: WorkflowExecutionContext,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await call(context, "builtin:jira", name, args);
    const output = object(result.output, "Jira tool output");
    return {
      ...result,
      sessionPatch: {
        ...result.sessionPatch,
        ticket: object(output.ticket, "Jira ticket output"),
      },
    };
  };
  executor.register("JIRA_CREATE_TICKET", (context) =>
    jiraTicketAction(context, "create_jira_ticket", {
      projectKey: text(context.node.config.projectKey, "Project key", 100),
      issueTypeId: text(context.node.config.issueTypeId, "Issue type ID", 100),
      summary: text(context.node.config.summary, "Summary"),
      description:
        typeof context.node.config.description === "string"
          ? { format: "MARKDOWN", value: context.node.config.description }
          : undefined,
      fields: context.node.config.fields
        ? object(context.node.config.fields, "Additional Jira fields")
        : undefined,
    }),
  );
  executor.register("JIRA_ADD_WORKLOG", (context) =>
    jiraTicketAction(context, "add_jira_worklog", {
      issueKey: contextual(context, "issueKey", "ticket.key", "Issue key"),
      timeSpentSeconds: Number(context.node.config.timeSpentSeconds),
      startedAt: optionalText(context.node.config.startedAt, 100),
      comment:
        typeof context.node.config.comment === "string"
          ? { format: "MARKDOWN", value: context.node.config.comment }
          : undefined,
    }),
  );
  executor.register("JIRA_LINK_TICKETS", (context) =>
    jiraTicketAction(context, "link_jira_tickets", {
      inwardIssueKey: contextual(
        context,
        "inwardIssueKey",
        "ticket.key",
        "Inward issue key",
      ),
      outwardIssueKey: text(
        context.node.config.outwardIssueKey,
        "Outward issue key",
        100,
      ),
      linkType: text(context.node.config.linkType, "Link type", 100),
    }),
  );
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
  workflows.registerWaitPoller("COMMAND_RUN", async (runId) => {
    const run = await services.commands.getRun(runId);
    if (!run) return { pending: false, error: "Command run disappeared" };
    if (
      new Set(["QUEUED", "RUNNING", "RESTARTING", "CANCELLING"]).has(run.status)
    ) {
      return { pending: true, pollAfterSeconds: 1 };
    }
    return {
      pending: false,
      result: {
        id: run.id,
        displayNumber: run.displayNumber,
        status: run.status,
        exitCode: run.exitCode,
        signal: run.signal,
        error: run.error,
      },
      error:
        run.status === "SUCCEEDED"
          ? null
          : run.error || `Command run ${run.status.toLowerCase()}`,
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
    const sessionPatch = move.targetWorktreeId
      ? await services.worktrees.workflowSessionDataForWorktree(
          move.targetWorktreeId,
          { includeMissing: true },
        )
      : {};
    return {
      pending: false,
      result: {
        id: move.id,
        status: move.status,
        targetWorktreeId: move.targetWorktreeId,
        sessionPatch,
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
    const sessionPatch =
      await services.worktrees.workflowSessionDataForWorktree(worktree.id, {
        includeMissing: true,
      });
    return {
      pending: false,
      result: {
        id: worktree.id,
        pushStatus: worktree.pushStatus,
        sessionPatch,
      },
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
      "WORKFLOW_AUTOMATION",
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
      result: {
        runId: run.id,
        status: run.status,
        jobs: run.jobs,
        sessionPatch: {
          pipeline: {
            runId: run.id,
            status: run.status,
            conclusion: run.status,
            jobs: run.jobs,
          },
        },
      },
      error:
        run.status === "SUCCESS"
          ? null
          : `GitHub checks concluded ${run.status.toLowerCase()}`,
    };
  });
  workflows.registerWaitPoller("DISK_SPACE_REPORT", async (externalKey) => {
    const input = object(JSON.parse(externalKey), "Disk-space report wait");
    const agentId = text(input.agentId, "Agent ID", 500);
    const snapshot = await services.diskSpace.snapshot(agentId);
    if (!snapshot.disk.enabled) {
      return {
        pending: false,
        error: "Disk-space monitoring was disabled while awaiting a report",
      };
    }
    const lastReportedAt = snapshot.disk.lastReportedAt;
    const previousReportedAt =
      typeof input.previousReportedAt === "string"
        ? input.previousReportedAt
        : null;
    text(input.requestedAt, "Requested timestamp", 100);
    const fresh = Boolean(
      lastReportedAt &&
      (previousReportedAt
        ? Date.parse(lastReportedAt) > Date.parse(previousReportedAt)
        : true),
    );
    if (!fresh) return { pending: true, pollAfterSeconds: 2 };
    return {
      pending: false,
      result: { ...snapshot, sessionPatch: snapshot },
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
    return {
      output: normalized,
      sessionPatch: { ticket: normalized },
      links: [
        jiraLink(
          String(normalized.key),
          String(normalized.title ?? normalized.key),
        ),
      ],
    };
  });
  executor.register("JIRA_TRANSITION", async (context) => {
    const ticket = await services.jira.transitionTicket(
      jiraKey(context),
      text(context.node.config.transitionId, "Jira transition ID", 200),
    );
    const normalized = normalizeTicket(ticket);
    return {
      output: normalized,
      sessionPatch: { ticket: normalized },
      links: [
        jiraLink(
          String(normalized.key),
          String(normalized.title ?? normalized.key),
        ),
      ],
    };
  });
  executor.register("JIRA_COMMENT", async (context) => {
    const ticket = await services.jira.addComment(jiraKey(context), {
      value: text(context.node.config.content, "Jira comment", 100_000),
      format:
        context.node.config.format === "JIRA_WIKI" ? "JIRA_WIKI" : "MARKDOWN",
    });
    const normalized = normalizeTicket(ticket);
    return {
      output: normalized,
      sessionPatch: { ticket: normalized },
      links: [
        jiraLink(
          String(normalized.key),
          String(normalized.title ?? normalized.key),
        ),
      ],
    };
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
    return {
      output: normalized,
      sessionPatch: { ticket: normalized },
      links: [
        jiraLink(
          String(normalized.key),
          String(normalized.title ?? normalized.key),
        ),
      ],
    };
  });
  executor.register("JIRA_UPDATE_FIELDS", async (context) => {
    const fields = object(context.node.config.fields ?? {}, "Jira fields");
    const ticket = await services.jira.updateTicket({
      issueKey: jiraKey(context),
      ...fields,
    } as Parameters<JiraService["updateTicket"]>[0]);
    const normalized = normalizeTicket(ticket);
    return {
      output: normalized,
      sessionPatch: { ticket: normalized },
      links: [
        jiraLink(
          String(normalized.key),
          String(normalized.title ?? normalized.key),
        ),
      ],
    };
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
      links: [jiraLink(preview.ticketKey, preview.ticketTitle)],
    };
  });
}

function contextualPullRequestNumber(
  context: WorkflowExecutionContext,
): number | null {
  const value =
    context.node.config.number ??
    getSessionValue(context.sessionData, "pr.number");
  const result = typeof value === "string" ? Number(value) : value;
  return typeof result === "number" && Number.isInteger(result) && result >= 1
    ? result
    : null;
}

function pullRequestNumber(context: WorkflowExecutionContext): number {
  const number = contextualPullRequestNumber(context);
  if (!number) throw new Error("Pull request number is required");
  return number;
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
      "WORKFLOW_AUTOMATION",
    );
    if (!pullRequest) throw new Error("Pull request was not found");
    const normalized = normalizePullRequest(pullRequest);
    return {
      output: normalized,
      sessionPatch: { pr: normalized },
      links: [
        detailLink(
          "PULL_REQUEST",
          pullRequestResourceId(
            repository.owner,
            repository.name,
            pullRequest.number,
          ),
          pullRequest.title,
          pullRequest.url,
        ),
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
      "WORKFLOW_AUTOMATION",
    );
    if (!options.canMerge)
      throw new Error(options.blockedReason || "Pull request cannot be merged");
    const result = await services.github.mergePullRequest(
      {
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
      },
      "WORKFLOW_AUTOMATION",
    );
    return {
      output: result,
      sessionPatch: { pr: { state: result.state } },
      links: [pullRequestLink(context)],
    };
  });
  executor.register("GITHUB_COLLECT_REVIEW_THREADS", async (context) => {
    const repository = githubCoordinates(context);
    const pullRequest = await services.github.pullRequest(
      repository.owner,
      repository.name,
      pullRequestNumber(context),
      "WORKFLOW_AUTOMATION",
    );
    if (!pullRequest) throw new Error("Pull request was not found");
    const unresolved = pullRequest.reviewThreads.filter(
      ({ isResolved }) => !isResolved,
    );
    return {
      output: unresolved,
      sessionPatch: { pr: { unresolvedThreads: unresolved } },
      links: [pullRequestLink(context, pullRequest.title, pullRequest.url)],
    };
  });
  executor.register("GITHUB_REPLY_REVIEW_THREAD", async (context) => {
    const result = await services.github.replyToReviewThread(
      text(context.node.config.threadId, "Review thread ID", 500),
      text(context.node.config.body, "Review reply", 100_000),
      "WORKFLOW_AUTOMATION",
    );
    const link = contextualPullRequestLink(context);
    return { output: result, links: link ? [link] : undefined };
  });
  executor.register("GITHUB_SET_REVIEW_THREAD_RESOLVED", async (context) => {
    const output = await services.github.setReviewThreadResolved(
      text(context.node.config.threadId, "Review thread ID", 500),
      context.node.config.resolved !== false,
      "WORKFLOW_AUTOMATION",
    );
    const link = contextualPullRequestLink(context);
    return { output, links: link ? [link] : undefined };
  });
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
    await services.worktrees.attachPullRequestForBranch(
      `github.com/${repository.owner}/${repository.name}`,
      pullRequest.headRefName,
      pullRequest,
    );
    const normalized = normalizePullRequest(pullRequest);
    return {
      output: normalized,
      sessionPatch: { pr: normalized },
      links: [
        detailLink(
          "PULL_REQUEST",
          pullRequestResourceId(
            repository.owner,
            repository.name,
            pullRequest.number,
          ),
          pullRequest.title,
          pullRequest.url,
        ),
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
      links: [pullRequestLink(context)],
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
      "WORKFLOW_AUTOMATION",
      { actor: "workflow", ipAddress: null },
    );
    const link = githubWorkflowRunLink(context);
    return {
      output: result,
      sessionPatch: { pipeline: { status: result.status } },
      links: link ? [link] : undefined,
    };
  });
  executor.register("GITHUB_RETRY_JOB", async (context) => {
    const output = await services.github.retryWorkflowJob(
      text(context.node.config.repositoryId, "GitHub repository ID", 500),
      text(context.node.config.checkSuiteId, "Check suite ID", 500),
      text(context.node.config.jobId, "Workflow job ID", 500),
      "WORKFLOW_AUTOMATION",
      { actor: "workflow", ipAddress: null },
    );
    const link = githubWorkflowRunLink(context);
    return { output, links: link ? [link] : undefined };
  });
  executor.register("GITHUB_CANCEL_WORKFLOW_RUN", async (context) => {
    const output = await services.github.cancelActionsWorkflowRun(
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
      "WORKFLOW_AUTOMATION",
      { actor: "workflow", ipAddress: null },
    );
    const link = githubWorkflowRunLink(context);
    return {
      output,
      sessionPatch: { pipeline: { status: "CANCELLED" } },
      links: link ? [link] : undefined,
    };
  });
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
    const link = githubWorkflowRunLink(context);
    return {
      links: link ? [link] : undefined,
      wait: {
        kind: "GITHUB_CHECKS",
        externalKey: JSON.stringify({ repositoryId, workflowRunId }),
        resumeAfter: waitResumeAfter(context.node.config),
        timeoutAt: waitTimeoutAt(context.node.config),
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
    return jobResult(context, job, {
      worktree: {
        branch: selection.branchName,
        baseBranch: selection.baseBranch,
      },
    });
  });
  executor.register("WORKTREE_CHANGE_BRANCH", async (context) => {
    const id = worktreeId(context);
    const selection = branchSelection(context);
    const job = await services.worktrees.changeWorktreeBranch({
      worktreeId: id,
      selection,
      requestId: requestId(context, "change-branch"),
      stashOnFailure: context.node.config.stashOnFailure === true,
    });
    return jobResult(
      context,
      job,
      {
        worktree: {
          branch: selection.branchName,
          baseBranch: selection.baseBranch,
        },
      },
      [worktreeLink(id)],
    );
  });
  executor.register("WORKTREE_REFRESH_PULL_REQUEST", async (context) => {
    const id = worktreeId(context);
    const worktree = await services.worktrees.refreshPullRequest(id);
    const pullRequest = worktree.pullRequest;
    const normalized = pullRequest ? normalizePullRequest(pullRequest) : null;
    const links = [worktreeLink(id)];
    if (pullRequest) {
      const [owner, name] = pullRequest.repositoryNameWithOwner.split("/");
      if (owner && name) {
        links.push(
          detailLink(
            "PULL_REQUEST",
            pullRequestResourceId(owner, name, pullRequest.number),
            pullRequest.title,
            pullRequest.url,
          ),
        );
      }
    }
    return {
      output: { found: Boolean(pullRequest), pullRequest },
      sessionPatch: { pr: normalized },
      links,
    };
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
    const id = worktreeId(context);
    const job = await services.worktrees.runOperation(
      id,
      operation as WorktreeOperation,
      requestId(context, operation.toLowerCase()),
    );
    return jobResult(context, job, undefined, [worktreeLink(id)]);
  });
  executor.register("WORKTREE_SET_AUTO_SYNC", async (context) => {
    const id = worktreeId(context);
    const action = String(context.node.config.action ?? "ENABLE").toUpperCase();
    const autoSync =
      action === "CANCEL"
        ? {
            cancelled: await services.worktreeAutomations.cancelAutoSync(id),
          }
        : action === "RETRY"
          ? await services.worktreeAutomations.retryAutoSync(id)
          : action === "ENABLE"
            ? await services.worktreeAutomations.configureAutoSync({
                worktreeId: id,
                conflictWorkflowId: optionalText(
                  context.node.config.conflictWorkflowId,
                  500,
                ),
                conflictWorkflowChoice: optionalText(
                  context.node.config.conflictWorkflowChoice,
                  500,
                ),
              })
            : null;
    if (!autoSync) throw new Error("Unknown Auto Sync action");
    return {
      output: autoSync,
      sessionPatch: { worktree: { autoSync } },
      links: [worktreeLink(id)],
    };
  });
  executor.register("WORKTREE_SET_AUTO_MERGE", async (context) => {
    const id = worktreeId(context);
    const action = String(context.node.config.action ?? "ENABLE").toUpperCase();
    let autoMerge: Record<string, unknown>;
    if (action === "CANCEL") {
      autoMerge = {
        cancelled: await services.worktreeAutomations.cancelAutoMerge(id),
      };
    } else if (action === "RETRY") {
      autoMerge = await services.worktreeAutomations.retryAutoMerge(id);
    } else if (action === "ENABLE") {
      const pullRequestNumber = Number(
        context.node.config.pullRequestNumber ??
          getSessionValue(context.sessionData, "pr.number"),
      );
      if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
        throw new Error("Pull request number must be a positive integer");
      }
      const method = String(
        context.node.config.method ?? "SQUASH",
      ).toUpperCase();
      if (!["MERGE", "REBASE", "SQUASH"].includes(method)) {
        throw new Error("Merge method is invalid");
      }
      autoMerge = await services.worktreeAutomations.configureAutoMerge({
        worktreeId: id,
        repositoryNameWithOwner: text(
          context.node.config.repositoryNameWithOwner ??
            getSessionValue(context.sessionData, "repo.nameWithOwner"),
          "Repository",
          500,
        ),
        pullRequestNumber,
        method: method as "MERGE" | "REBASE" | "SQUASH",
        commitHeadline: text(
          context.node.config.commitHeadline ??
            getSessionValue(context.sessionData, "pr.title"),
          "Commit headline",
          1_000,
        ),
        commitBody: String(context.node.config.commitBody ?? ""),
        authorEmail: optionalText(context.node.config.authorEmail, 500),
        deleteWorktree: context.node.config.deleteWorktree === true,
        moveTicketToDone: context.node.config.moveTicketToDone === true,
      });
    } else {
      throw new Error("Unknown Auto Merge action");
    }
    return {
      output: autoMerge,
      sessionPatch: { worktree: { autoMerge } },
      links: [worktreeLink(id)],
    };
  });
  executor.register("WORKTREE_DELETE", async (context) => {
    const job = await services.worktrees.deleteWorktree({
      worktreeId: worktreeId(context),
      deleteRemoteBranch: context.node.config.deleteRemoteBranch === true,
      requestId: requestId(context, "delete"),
    });
    return jobResult(context, job);
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
    const linkedWorktreeId =
      move.targetWorktreeId ??
      (context.node.config.deleteSource === true ? null : worktreeId(context));
    return {
      output: move,
      links: [
        ...(linkedWorktreeId ? [worktreeLink(linkedWorktreeId)] : []),
        {
          kind: "WORKTREE_MOVE",
          resourceId: move.id,
          label: "Worktree move",
        },
      ],
      wait: {
        kind: "WORKTREE_MOVE",
        externalKey: move.id,
        resumeAfter: waitResumeAfter(context.node.config),
        timeoutAt: waitTimeoutAt(context.node.config),
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
      links: [worktreeLink(id)],
    };
  });
  executor.register("WORKTREE_INSPECT_GIT", async (context) => {
    const id = worktreeId(context);
    const state = await services.worktrees.inspectGitState(
      id,
      requestId(context, "inspect-git"),
    );
    return {
      output: state,
      sessionPatch: { worktree: { ...state } },
      links: [worktreeLink(id)],
    };
  });
  executor.register("WORKTREE_GIT_OPERATION", async (context) => {
    const operation = String(
      context.node.config.operation ?? "PULL_BRANCH",
    ).toUpperCase();
    if (!WORKTREE_GIT_OPERATIONS.includes(operation as WorktreeGitOperation)) {
      throw new Error("Worktree Git operation is invalid");
    }
    const id = worktreeId(context);
    const job = await services.worktrees.runGitOperation({
      worktreeId: id,
      operation: operation as WorktreeGitOperation,
      branch: optionalText(context.node.config.branch, 500),
      stashOid: optionalText(context.node.config.stashOid, 200),
      stashChanges: context.node.config.stashChanges === true,
      requestId: requestId(context, operation.toLowerCase()),
    });
    return jobResult(context, job, undefined, [worktreeLink(id)]);
  });
  executor.register("WORKTREE_WAIT_PUSH_READY", async (context) => {
    const id = worktreeId(context);
    return {
      links: [worktreeLink(id)],
      wait: {
        kind: "WORKTREE_PUSH_READY",
        externalKey: id,
        resumeAfter: waitResumeAfter(context.node.config),
        timeoutAt: waitTimeoutAt(context.node.config),
      },
    };
  });
}

function registerCodebaseAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  executor.register("CODEBASE_FETCH_REFRESH", async (context) => {
    const id = codebaseId(context);
    const kind =
      context.node.config.operation === "REFRESH"
        ? CODEBASE_REFRESH_JOB_KIND
        : CODEBASE_FETCH_JOB_KIND;
    const result = await services.codebases.runOperation(
      kind,
      [id],
      requestId(context, kind),
    );
    const job = result.jobs[0];
    if (!job) {
      throw new Error(
        result.skipped[0]?.reason ?? "Codebase operation was skipped",
      );
    }
    return jobResult(context, job, undefined, [codebaseLink(id)]);
  });
  executor.register("CODEBASE_INSPECT_GIT", async (context) => {
    const id = codebaseId(context);
    const state = await services.codebases.inspectGitState(
      id,
      requestId(context, "inspect-git"),
    );
    return {
      output: state,
      sessionPatch: { codebase: { ...state } },
      links: [codebaseLink(id)],
    };
  });
  executor.register("CODEBASE_GIT_OPERATION", async (context) => {
    const operation = String(
      context.node.config.operation ?? "PULL_BRANCH",
    ).toUpperCase();
    if (!CODEBASE_GIT_OPERATIONS.includes(operation as CodebaseGitOperation)) {
      throw new Error("Codebase Git operation is invalid");
    }
    const id = codebaseId(context);
    const job = await services.codebases.runGitOperation({
      codebaseId: id,
      operation: operation as CodebaseGitOperation,
      branch: optionalText(context.node.config.branch, 500),
      stashOid: optionalText(context.node.config.stashOid, 200),
      stashChanges: context.node.config.stashChanges === true,
      requestId: requestId(context, operation.toLowerCase()),
    });
    return jobResult(context, job, undefined, [codebaseLink(id)]);
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
        resumeAfter: waitResumeAfter(context.node.config),
        timeoutAt: waitTimeoutAt(context.node.config),
      },
    };
  });
  executor.register("BUILD_READ_TEST_RESULTS", async (context) => {
    const id = buildId(context);
    const report = (await services.builds.reportsForBuild(id))
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
      links: [buildLink(id)],
    };
  });
  executor.register("BUILD_READ_COVERAGE", async (context) => {
    const id = buildId(context);
    const report = (await services.builds.reportsForBuild(id))
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
      links: [buildLink(id, `/builds/${id}/coverage`)],
    };
  });
  executor.register("BUILD_EXPORT", async (context) => {
    const id = buildId(context);
    const result = await services.builds.exportArchive({
      buildId: id,
      requestId: requestId(context, "export"),
      settings: object(context.node.config.settings, "Export settings"),
    });
    return result.jobId
      ? jobResult(
          context,
          { id: result.jobId, timeoutSeconds: 3_600 },
          {
            build: { exportId: result.id },
          },
          [buildLink(id)],
        )
      : { output: result, links: [buildLink(id)] };
  });
  executor.register("BUILD_DEPLOY", async (context) => {
    const id = buildId(context);
    const deployments = await services.builds.runBuild({
      buildId: id,
      destinations: Array.isArray(context.node.config.destinations)
        ? context.node.config.destinations
        : [],
      requestId: requestId(context, "deploy"),
    });
    const jobId = deployments.find(({ jobId }) => Boolean(jobId))?.jobId;
    return jobId
      ? jobResult(context, { id: jobId, timeoutSeconds: 3_600 }, undefined, [
          buildLink(id),
        ])
      : { output: deployments, links: [buildLink(id)] };
  });
  executor.register("BUILD_CANCEL", async (context) => {
    const id = buildId(context);
    const build = await services.builds.cancelBuild(id);
    return {
      output: build,
      sessionPatch: { build: { id: build?.id, status: build?.status } },
      links: [buildLink(id)],
    };
  });
}

function diskSpaceAgentId(context: WorkflowExecutionContext): string {
  return text(
    context.node.config.agentId ??
      getSessionValue(context.sessionData, "agent.id") ??
      getSessionValue(context.sessionData, "codebase.agentId"),
    "Agent ID",
    500,
  );
}

function registerDiskSpaceAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  const snapshotResult = async (agentId: string) => {
    const snapshot = await services.diskSpace.snapshot(agentId);
    return {
      output: snapshot,
      sessionPatch: snapshot,
      links: [
        detailLink(
          "AGENT",
          agentId,
          snapshot.agent.name,
          `/agents/${encodeURIComponent(agentId)}`,
        ),
      ],
    };
  };

  executor.register("DISK_SPACE_LOAD", async (context) =>
    snapshotResult(diskSpaceAgentId(context)),
  );
  executor.register("DISK_SPACE_REFRESH", async (context) => {
    const agentId = diskSpaceAgentId(context);
    const request = await services.diskSpace.requestRefresh(agentId);
    return {
      output: request,
      links: [
        detailLink(
          "AGENT",
          agentId,
          "Agent",
          `/agents/${encodeURIComponent(agentId)}`,
        ),
      ],
      wait: {
        kind: "DISK_SPACE_REPORT",
        externalKey: JSON.stringify(request),
        resumeAfter: waitResumeAfter(context.node.config, 2),
        timeoutAt: waitTimeoutAt(context.node.config, 180),
      },
    };
  });
  executor.register("DISK_SPACE_UPDATE_THRESHOLDS", async (context) => {
    const settings = await services.diskSpace.updateSettings({
      normalThresholdGiB: Number(context.node.config.normalThresholdGiB),
      pressureThresholdGiB: Number(context.node.config.pressureThresholdGiB),
    });
    return { output: settings, sessionPatch: { disk: settings } };
  });
  executor.register("DISK_SPACE_SET_MONITORING", async (context) => {
    const agentId = diskSpaceAgentId(context);
    await services.diskSpace.setMonitoring(
      agentId,
      context.node.config.enabled === true,
    );
    return snapshotResult(agentId);
  });
  executor.register("DISK_SPACE_SET_PRESSURE_MODE", async (context) => {
    const agentId = diskSpaceAgentId(context);
    await services.diskSpace.setManualPressureMode(
      agentId,
      context.node.config.enabled === true,
    );
    return snapshotResult(agentId);
  });
}

function contextualAgentRunId(
  context: WorkflowExecutionContext,
): string | null {
  try {
    return agentRunId(context);
  } catch {
    return null;
  }
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
    const link = contextualAgentRunLink(context);
    return {
      links: link ? [link] : undefined,
      wait: {
        kind: "RUN_ANSWER_REVISION",
        externalKey: JSON.stringify({
          batchId,
          answers: context.node.config.answers ?? {},
          stash: context.node.config.stash === true,
          rollback: context.node.config.rollback !== false,
        }),
        resumeAfter: waitResumeAfter(context.node.config),
        timeoutAt: waitTimeoutAt(context.node.config),
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
    const runLink = contextualAgentRunLink(context);
    return {
      output: checkpoint,
      sessionPatch: {
        steps: { [context.node.id]: { snapshotId: checkpoint.id } },
      },
      links: [
        ...(runLink ? [runLink] : []),
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
    const deleting = context.node.config.delete === true;
    const affected = deleting
      ? await services.runs.deleteRuns([id])
      : await services.runs.archive(
          [id],
          context.node.config.archived !== false,
        );
    const link = deleting ? null : contextualAgentRunLink(context);
    return { output: { id, affected }, links: link ? [link] : undefined };
  });
}

function registerMiscellaneousAdapters(
  executor: WorkflowStepExecutor,
  services: WorkflowAdapterServices,
): void {
  executor.register("SAVED_COMMAND", async (context) => {
    const commandId = text(context.node.config.commandId, "Saved command", 500);
    const definition = await services.commands.getDefinition(commandId);
    if (!definition || definition.archivedAt)
      throw new Error("Saved command is unavailable");
    const completionMode =
      context.node.config.completionMode === "FIRE_AND_FORGET"
        ? "FIRE_AND_FORGET"
        : "WAIT_FOR_EXIT";
    if (
      completionMode === "WAIT_FOR_EXIT" &&
      definition.restartPolicy === "ALWAYS"
    ) {
      throw new Error("Always-restart commands require fire and forget");
    }
    const targetMode = String(context.node.config.targetMode ?? "CONTEXT");
    let agentId: string | null = null;
    let worktreeId: string | null = null;
    const home = new Set(["ANY_AGENT_HOME", "SPECIFIC_AGENT_HOME"]).has(
      definition.targetKind,
    );
    if (targetMode === "FIXED_AGENT") {
      agentId = text(context.node.config.agentId, "Fixed agent", 500);
    } else if (targetMode === "FIXED_WORKTREE") {
      worktreeId = text(context.node.config.worktreeId, "Fixed worktree", 500);
    } else if (home) {
      const configured =
        getSessionValue(context.sessionData, "agent.id") ??
        getSessionValue(context.sessionData, "codebase.agentId");
      if (typeof configured === "string") agentId = configured;
      if (!agentId) {
        const contextWorktreeId = getSessionValue(
          context.sessionData,
          "worktree.id",
        );
        if (typeof contextWorktreeId === "string") {
          const prisma = await getPrismaClient();
          const worktree = await prisma.worktree.findUnique({
            where: { id: contextWorktreeId },
            select: { codebase: { select: { agentId: true } } },
          });
          agentId = worktree?.codebase.agentId ?? null;
        }
      }
    } else {
      const configured = getSessionValue(context.sessionData, "worktree.id");
      if (typeof configured === "string") worktreeId = configured;
    }
    const run = await services.commands.startRun({
      commandId,
      agentId,
      worktreeId,
      origin: "WORKFLOW",
      idempotencyKey: context.attempt.idempotencyKey,
    });
    if (!run) throw new Error("Command run could not be created");
    return {
      output: {
        id: run.id,
        displayNumber: run.displayNumber,
        status: run.status,
      },
      sessionPatch: {
        steps: {
          [context.node.id]: {
            commandRunId: run.id,
            displayNumber: run.displayNumber,
          },
        },
      },
      links: [
        {
          kind: "COMMAND_RUN",
          resourceId: run.id,
          label: `Command #${run.displayNumber}`,
          url: `/commands/runs/${run.id}`,
        },
      ],
      wait:
        completionMode === "WAIT_FOR_EXIT"
          ? {
              kind: "COMMAND_RUN",
              externalKey: run.id,
              resumeAfter: waitResumeAfter(context.node.config),
              timeoutAt: waitTimeoutAt(context.node.config),
            }
          : undefined,
    };
  });
  executor.register("CUSTOM_COMMAND", async (context) => {
    const script = text(
      context.node.config.script,
      "Custom command",
      1_000_000,
    );
    const completionMode =
      context.node.config.completionMode === "FIRE_AND_FORGET"
        ? "FIRE_AND_FORGET"
        : "WAIT_FOR_EXIT";
    const targetMode = String(context.node.config.targetMode ?? "CONTEXT");
    let agentId: string | null = null;
    let worktreeId: string | null = null;
    if (targetMode === "FIXED_AGENT") {
      agentId = text(context.node.config.agentId, "Fixed agent", 500);
    } else if (targetMode === "FIXED_WORKTREE") {
      worktreeId = text(context.node.config.worktreeId, "Fixed worktree", 500);
    } else {
      const contextualWorktree = getSessionValue(
        context.sessionData,
        "worktree.id",
      );
      if (typeof contextualWorktree === "string") {
        worktreeId = contextualWorktree;
      } else {
        const contextualAgent =
          getSessionValue(context.sessionData, "agent.id") ??
          getSessionValue(context.sessionData, "codebase.agentId");
        if (typeof contextualAgent === "string") agentId = contextualAgent;
      }
    }
    if (!agentId && !worktreeId) {
      throw new Error("Custom command context has no agent or worktree target");
    }
    const run = await services.commands.startCustomRun({
      script,
      agentId,
      worktreeId,
      origin: "WORKFLOW",
      idempotencyKey: context.attempt.idempotencyKey,
    });
    if (!run) throw new Error("Custom command run could not be created");
    return {
      output: {
        id: run.id,
        displayNumber: run.displayNumber,
        status: run.status,
      },
      sessionPatch: {
        steps: {
          [context.node.id]: {
            commandRunId: run.id,
            displayNumber: run.displayNumber,
          },
        },
      },
      links: [
        {
          kind: "COMMAND_RUN",
          resourceId: run.id,
          label: `Command #${run.displayNumber}`,
          url: `/commands/runs/${run.id}`,
        },
      ],
      wait:
        completionMode === "WAIT_FOR_EXIT"
          ? {
              kind: "COMMAND_RUN",
              externalKey: run.id,
              resumeAfter: waitResumeAfter(context.node.config),
              timeoutAt: waitTimeoutAt(context.node.config),
            }
          : undefined,
    };
  });
  executor.register("SKILL_APPLY", async (context) => {
    const run = await services.skills.prepareSync(
      context.node.config.groupId ? "GROUP" : "ALL",
      optionalText(context.node.config.groupId, 500),
      false,
    );
    if (!run) throw new Error("Skill sync could not be prepared");
    return {
      output: run,
      links: [
        {
          kind: "SKILL_RUN",
          resourceId: run.id,
          label: "Skill sync",
          url: `/skills/sync/${run.id}`,
        },
      ],
      wait: {
        kind: "SKILL_RUN",
        externalKey: run.id,
        resumeAfter: waitResumeAfter(context.node.config),
        timeoutAt: waitTimeoutAt(context.node.config),
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
    const result = await services.tools.callTool(
      {
        groupId: text(context.node.config.groupId, "MCP tool group", 500),
        name: text(context.node.config.name, "MCP tool name", 500),
        arguments: object(context.node.config.arguments ?? {}, "MCP arguments"),
      },
      {
        caller: `workflow:${context.run.id}`,
        correlationId: context.attempt.id,
        source: "WORKFLOW",
      },
    );
    return {
      output: result,
      sessionPatch: { steps: { [context.node.id]: { output: result } } },
    };
  });
}
