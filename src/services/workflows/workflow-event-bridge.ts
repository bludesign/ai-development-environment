import "server-only";

import { randomUUID } from "node:crypto";

import { DISK_SPACE_POLL_INTERVAL_SECONDS } from "@ai-development-environment/agent-contract/disk-space";

import {
  AGENT_CHANGED_TOPIC,
  BUILDS_CHANGED_TOPIC,
  CODEBASE_CHANGED_TOPIC,
  RUNS_CHANGED_TOPIC,
  WORKTREE_CHANGED_TOPIC,
  agentEventBus,
  type AgentControlService,
} from "@/services/agent-control";
import { getPrismaClient } from "@/data/prisma-client";
import { mergeSessionData } from "@/lib/workflows/session";
import {
  diskSpaceSessionData,
  diskSpaceStateCursor,
  type DiskSpaceChangedPayload,
  type DiskSpaceCleanupChange,
  type DiskSpaceService,
  type DiskSpaceSessionData,
} from "@/services/disk-space";
import type { WorktreesService } from "@/services/worktrees";

import type { WorkflowEventsService } from "./workflow-events.service";

type SessionData = Record<string, unknown>;

function parsed(value: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(value);
    return result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function repositoryData(
  repository: {
    id: string;
    name: string;
    canonicalOrigin: string;
    displayOrigin: string;
  },
  defaultBranch?: string | null,
) {
  return {
    id: repository.id,
    name: repository.name,
    url: repository.displayOrigin,
    canonicalOrigin: repository.canonicalOrigin,
    displayOrigin: repository.displayOrigin,
    defaultBranch: defaultBranch ?? null,
  };
}

function agentData(agent: {
  id: string;
  name: string;
  hostname: string;
  disconnectedAt: Date | null;
  diskFreeBytes: number | null;
  memoryFreeBytes: number | null;
}) {
  return {
    id: agent.id,
    name: agent.name,
    hostname: agent.hostname,
    connected: agent.disconnectedAt === null,
    diskFreeBytes: agent.diskFreeBytes,
    memoryFreeBytes: agent.memoryFreeBytes,
  };
}

export class WorkflowEventBridge {
  private started = false;
  private running = false;
  private diskAuditTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly diskStateFingerprints = new Map<string, string>();

  constructor(
    private readonly events: WorkflowEventsService,
    private readonly agentControl: AgentControlService,
    private readonly worktrees?: Pick<
      WorktreesService,
      "workflowSessionDataForWorktree"
    >,
    private readonly diskSpace?: DiskSpaceService,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.running = true;
    this.agentControl.registerCompletionObserver((job) =>
      this.observeAgentJob(job),
    );
    void this.consumeRuns();
    void this.consumeBuilds();
    void this.consumeWorktrees();
    void this.consumeCodebases();
    void this.consumeAgents();
    if (this.diskSpace) {
      void this.consumeDiskSpace();
      void this.auditDiskSpace(true);
    }
  }

  stop(): void {
    this.running = false;
    if (this.diskAuditTimer) clearTimeout(this.diskAuditTimer);
    this.diskAuditTimer = undefined;
  }

  private async record(
    kind: string,
    subjectKey: string,
    dedupeKey: string,
    sessionData: SessionData,
    extras: Record<string, unknown> = {},
  ): Promise<void> {
    await this.events.record({
      kind,
      subjectKey,
      dedupeKey,
      payload: { ...sessionData, ...extras, sessionData },
    });
  }

  private async worktreeSessionData(
    worktreeId: string | null,
    includeMissing = false,
  ): Promise<SessionData> {
    if (!worktreeId || !this.worktrees) return {};
    return this.worktrees.workflowSessionDataForWorktree(worktreeId, {
      includeMissing,
    });
  }

  private async observeAgentJob(job: {
    id: string;
    kind: string;
    status: string;
    error: string | null;
    agentId: string;
    codebaseId: string | null;
    worktreeId: string | null;
    ccusageCollectionId?: string | null;
    resultJson: string | null;
  }): Promise<void> {
    if (
      job.kind === "ccusage.report" &&
      job.status === "SUCCEEDED" &&
      job.resultJson
    ) {
      const result = parsed(job.resultJson);
      const report =
        result.report &&
        typeof result.report === "object" &&
        !Array.isArray(result.report)
          ? (result.report as Record<string, unknown>)
          : {};
      const totals =
        report.totals &&
        typeof report.totals === "object" &&
        !Array.isArray(report.totals)
          ? (report.totals as Record<string, unknown>)
          : {};
      await this.record(
        "CCUSAGE_THRESHOLD",
        job.agentId,
        `ccusage:${job.ccusageCollectionId ?? job.id}:${job.agentId}`,
        { run: { usage: totals }, agent: { id: job.agentId } },
        { cursorValue: job.ccusageCollectionId ?? job.id },
      );
      return;
    }
    if (!new Set(["FAILED", "TIMED_OUT"]).has(job.status)) return;
    const targetSessionData = await this.worktreeSessionData(
      job.worktreeId,
      true,
    );
    await this.record(
      "AGENT_JOB_FAILED",
      job.agentId,
      `agent-job:${job.id}:${job.status}`,
      mergeSessionData(targetSessionData, {
        agent: { id: job.agentId },
        codebase: { id: job.codebaseId, agentId: job.agentId },
        ...(job.worktreeId ? { worktree: { id: job.worktreeId } } : {}),
        steps: {
          trigger: {
            id: job.id,
            kind: job.kind,
            status: job.status,
            error: job.error,
          },
        },
      }),
      { cursorValue: `${job.id}:${job.status}` },
    );
  }

  private async consumeRuns(): Promise<void> {
    const stream = agentEventBus.iterate<{ runChanged: { id: string } }>(
      RUNS_CHANGED_TOPIC,
    );
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        if (payload.runChanged.id !== "drafts") {
          await this.observeRun(payload.runChanged.id).catch((error) =>
            console.error("Could not record workflow run trigger:", error),
          );
        }
      }
    } finally {
      await stream.return?.();
    }
  }

  private async observeRun(runId: string): Promise<void> {
    const prisma = await getPrismaClient();
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: {
        worktree: { include: { codebase: { include: { repository: true } } } },
        agent: {
          select: {
            id: true,
            name: true,
            hostname: true,
            disconnectedAt: true,
            diskFreeBytes: true,
            memoryFreeBytes: true,
          },
        },
        questionBatches: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { questions: { include: { options: true } } },
        },
        events: { orderBy: { sequence: "desc" }, take: 1 },
        toolCalls: { orderBy: { sequence: "desc" }, take: 1 },
      },
    });
    if (!run) return;
    const owner = await prisma.workflowRunResourceLink.findFirst({
      where: { kind: "AGENT_RUN", resourceId: run.id },
      include: { run: true },
      orderBy: { createdAt: "desc" },
    });
    const targetSessionData = await this.worktreeSessionData(
      run.worktree?.id ?? null,
    );
    const sessionData: SessionData = mergeSessionData(targetSessionData, {
      run: {
        id: run.id,
        kind: run.kind,
        status: run.status,
        phase: run.phase,
        origin: run.origin,
        provider: run.provider,
        model: run.model,
        finalOutput: run.finalOutput,
        error: run.error,
        sourcePlanId: run.sourcePlanId,
        parentRunId: run.parentRunId,
        followUpMode: run.followUpMode,
        usage: {
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          reasoningTokens: run.reasoningTokens,
          cacheReadTokens: run.cacheReadTokens,
          cacheWriteTokens: run.cacheWriteTokens,
          toolCallCount: run.toolCallCount,
          estimatedCost: run.estimatedCost,
        },
      },
      ...(run.worktree
        ? {
            worktree: {
              id: run.worktree.id,
              path: run.worktree.folder,
              branch: run.worktree.branch,
              headSha: run.worktree.headSha,
            },
            codebase: {
              id: run.worktree.codebase.id,
              folder: run.worktree.codebase.folder,
              agentId: run.worktree.codebase.agentId,
            },
            repo: repositoryData(
              run.worktree.codebase.repository,
              run.worktree.codebase.defaultBranch,
            ),
          }
        : {}),
      ...(run.agent ? { agent: agentData(run.agent) } : {}),
      ...(run.jiraIssueKey ? { ticket: { key: run.jiraIssueKey } } : {}),
    });
    const correlation = owner
      ? {
          workflowId: owner.run.workflowId,
          runId: owner.runId,
          attemptId: owner.attemptId,
        }
      : null;
    const extras = {
      cursorValue: `${run.status}:${run.phase}`,
      workflowCorrelation: correlation,
    };
    if (run.startedAt) {
      await this.record(
        "RUN_STARTED",
        run.id,
        `run-started:${run.id}:${run.startedAt.toISOString()}`,
        sessionData,
        extras,
      );
    }
    const statusKind =
      run.status === "COMPLETED"
        ? "RUN_COMPLETED"
        : run.status === "FAILED"
          ? "RUN_FAILED"
          : run.status === "CANCELLED"
            ? "RUN_CANCELLED"
            : run.status === "PAUSED"
              ? "RUN_PAUSED"
              : null;
    if (statusKind) {
      await this.record(
        statusKind,
        run.id,
        `run-status:${run.id}:${run.status}:${run.finishedAt?.toISOString() ?? run.updatedAt.toISOString()}`,
        sessionData,
        extras,
      );
    }
    if (
      run.phase === "RUNNING" &&
      run.startedAt &&
      run.updatedAt > run.startedAt
    ) {
      await this.record(
        "RUN_CONTINUED",
        run.id,
        `run-continued:${run.id}:${run.updatedAt.toISOString()}`,
        sessionData,
        extras,
      );
    }
    if (run.sourcePlanId) {
      await this.record(
        "RUN_PLAN_PLAYED",
        run.id,
        `run-plan-played:${run.id}:${run.sourcePlanId}`,
        sessionData,
        extras,
      );
    }
    if (run.parentRunId && run.followUpMode !== "PLAN_PLAY") {
      await this.record(
        "RUN_FOLLOW_UP",
        run.id,
        `run-follow-up:${run.id}:${run.parentRunId}`,
        sessionData,
        extras,
      );
    }
    if (run.origin === "IMPORTED") {
      await this.record(
        "RUN_IMPORTED",
        run.id,
        `run-imported:${run.id}:${run.updatedAt.toISOString()}`,
        sessionData,
        extras,
      );
    }
    await this.record(
      "RUN_USAGE_THRESHOLD",
      run.id,
      `run-usage:${run.id}:${run.updatedAt.toISOString()}`,
      sessionData,
      { ...extras, cursorValue: run.updatedAt.toISOString() },
    );
    const question = run.questionBatches[0];
    if (question) {
      const questionData = {
        ...sessionData,
        run: {
          ...(sessionData.run as Record<string, unknown>),
          questions: question.questions,
        },
      };
      if (question.status === "PENDING") {
        await this.record(
          "RUN_QUESTION_NEEDED",
          run.id,
          `run-question:${question.id}:pending`,
          questionData,
          extras,
        );
      } else if (question.status === "ANSWERED") {
        await this.record(
          "RUN_QUESTION_ANSWERED",
          run.id,
          `run-question:${question.id}:answered`,
          questionData,
          extras,
        );
      }
    }
    const event = run.events[0];
    if (event) {
      await this.record(
        "RUN_EVENT_MATCH",
        run.id,
        `run-event:${event.id}`,
        sessionData,
        { ...extras, event },
      );
    }
    const toolCall = run.toolCalls[0];
    if (toolCall) {
      await this.record(
        "RUN_EVENT_MATCH",
        run.id,
        `run-tool:${toolCall.id}:${toolCall.status}`,
        sessionData,
        { ...extras, toolCall },
      );
    }
  }

  private async consumeBuilds(): Promise<void> {
    const stream = agentEventBus.iterate<{ buildsChanged: { id: string } }>(
      BUILDS_CHANGED_TOPIC,
    );
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        await this.observeBuild(payload.buildsChanged.id).catch((error) =>
          console.error("Could not record workflow build trigger:", error),
        );
      }
    } finally {
      await stream.return?.();
    }
  }

  private async observeBuild(buildId: string): Promise<void> {
    const prisma = await getPrismaClient();
    const build = await prisma.build.findUnique({
      where: { id: buildId },
      include: {
        codebase: {
          include: {
            repository: true,
            agent: {
              select: {
                id: true,
                name: true,
                hostname: true,
                disconnectedAt: true,
                diskFreeBytes: true,
                memoryFreeBytes: true,
              },
            },
          },
        },
        worktree: true,
        reports: true,
        scriptExecutions: true,
      },
    });
    if (!build) return;
    const targetSessionData = await this.worktreeSessionData(
      build.worktree?.id ?? null,
    );
    const sessionData: SessionData = mergeSessionData(targetSessionData, {
      build: {
        id: build.id,
        status: build.status,
        action: build.action,
        error: build.error,
      },
      ...(build.codebase
        ? {
            codebase: {
              id: build.codebase.id,
              folder: build.codebase.folder,
              agentId: build.codebase.agentId,
            },
            repo: repositoryData(
              build.codebase.repository,
              build.codebase.defaultBranch,
            ),
            agent: agentData(build.codebase.agent),
          }
        : {}),
      ...(build.worktree
        ? {
            worktree: {
              id: build.worktree.id,
              path: build.worktree.folder,
              branch: build.worktree.branch,
              headSha: build.worktree.headSha,
            },
          }
        : {}),
    });
    if (new Set(["SUCCEEDED", "FAILED", "CANCELLED"]).has(build.status)) {
      await this.record(
        "BUILD_RESULT",
        build.id,
        `build-result:${build.id}:${build.status}`,
        sessionData,
        { cursorValue: build.status },
      );
    }
    for (const report of build.reports.filter(
      ({ status }) => status === "READY",
    )) {
      const summary = parsed(report.summaryJson);
      const reportData = {
        ...sessionData,
        build: {
          ...(sessionData.build as Record<string, unknown>),
          ...(report.kind === "TEST_RESULTS"
            ? { testSummary: summary }
            : { coverageSummary: summary }),
        },
      };
      await this.record(
        report.kind === "TEST_RESULTS"
          ? "BUILD_TEST_THRESHOLD"
          : "BUILD_COVERAGE_THRESHOLD",
        build.id,
        `build-report:${report.id}:${report.updatedAt.toISOString()}`,
        reportData,
        { cursorValue: report.updatedAt.toISOString() },
      );
    }
    for (const execution of build.scriptExecutions.filter(
      ({ causedBuildFailure }) => causedBuildFailure,
    )) {
      await this.record(
        "BUILD_HOOK_FAILED",
        build.id,
        `build-hook:${execution.id}:failed`,
        sessionData,
        {
          cursorValue: execution.id,
          script: {
            id: execution.id,
            name: execution.nameSnapshot,
            phase: execution.phase,
          },
        },
      );
    }
  }

  private async consumeWorktrees(): Promise<void> {
    const stream = agentEventBus.iterate<{
      worktreeOverviewChanged: {
        worktreeId: string | null;
        codebaseId: string | null;
      };
    }>(WORKTREE_CHANGED_TOPIC);
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const change = payload.worktreeOverviewChanged;
        const prisma = await getPrismaClient();
        const rows = await prisma.worktree.findMany({
          where: change.worktreeId
            ? { id: change.worktreeId }
            : change.codebaseId
              ? { codebaseId: change.codebaseId }
              : {},
          include: { codebase: { include: { repository: true } } },
          take: change.worktreeId ? 1 : 500,
        });
        for (const worktree of rows) {
          await this.observeWorktree(worktree).catch((error) =>
            console.error("Could not record workflow worktree trigger:", error),
          );
        }
      }
    } finally {
      await stream.return?.();
    }
  }

  private async observeWorktree(worktree: {
    id: string;
    folder: string;
    branch: string | null;
    headSha: string | null;
    pushStatus: string;
    baseBehind: number | null;
    hasStagedChanges: boolean;
    hasUnstagedChanges: boolean;
    lastCheckedAt: Date | null;
    missingAt: Date | null;
    updatedAt: Date;
    codebase: {
      id: string;
      folder: string;
      agentId: string;
      defaultBranch: string | null;
      repository: {
        id: string;
        name: string;
        canonicalOrigin: string;
        displayOrigin: string;
      };
    };
  }): Promise<void> {
    const observedAt = worktree.lastCheckedAt ?? worktree.updatedAt;
    const dirty = worktree.hasStagedChanges || worktree.hasUnstagedChanges;
    const targetSessionData = await this.worktreeSessionData(worktree.id, true);
    const sessionData: SessionData = mergeSessionData(targetSessionData, {
      repo: repositoryData(
        worktree.codebase.repository,
        worktree.codebase.defaultBranch,
      ),
      codebase: {
        id: worktree.codebase.id,
        folder: worktree.codebase.folder,
        agentId: worktree.codebase.agentId,
      },
      worktree: {
        id: worktree.id,
        path: worktree.folder,
        branch: worktree.branch,
        headSha: worktree.headSha,
        pushStatus: worktree.pushStatus,
        baseBehind: worktree.baseBehind,
        dirty,
        missingAt: worktree.missingAt?.toISOString() ?? null,
        dirtySince: dirty ? worktree.updatedAt.toISOString() : null,
      },
    });
    const common = { cursorValue: observedAt.toISOString() };
    if ((worktree.baseBehind ?? 0) > 0) {
      await this.record(
        "WORKTREE_BEHIND",
        worktree.id,
        `worktree-behind:${worktree.id}:${observedAt.toISOString()}`,
        sessionData,
        common,
      );
    }
    await this.record(
      "WORKTREE_DIRTY_DURATION",
      worktree.id,
      `worktree-dirty:${worktree.id}:${observedAt.toISOString()}`,
      sessionData,
      common,
    );
    await this.record(
      "WORKTREE_MISSING",
      worktree.id,
      `worktree-missing:${worktree.id}:${observedAt.toISOString()}`,
      sessionData,
      { cursorValue: Boolean(worktree.missingAt) },
    );
    await this.record(
      "WORKTREE_DIVERGED",
      worktree.id,
      `worktree-diverged:${worktree.id}:${observedAt.toISOString()}`,
      sessionData,
      { cursorValue: worktree.pushStatus === "DIVERGED" },
    );
    if (worktree.headSha) {
      await this.record(
        "WORKTREE_NEW_COMMIT",
        worktree.id,
        `worktree-commit:${worktree.id}:${worktree.headSha}`,
        sessionData,
        { cursorValue: worktree.headSha },
      );
    }
  }

  private async consumeCodebases(): Promise<void> {
    const stream = agentEventBus.iterate<{
      codebaseOverviewChanged: {
        codebaseId: string | null;
        repositoryId: string | null;
      };
    }>(CODEBASE_CHANGED_TOPIC);
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const prisma = await getPrismaClient();
        const change = payload.codebaseOverviewChanged;
        const codebases = await prisma.codebase.findMany({
          where: change.codebaseId
            ? { id: change.codebaseId }
            : change.repositoryId
              ? { repositoryId: change.repositoryId }
              : {},
          include: {
            repository: true,
            agent: {
              select: {
                id: true,
                name: true,
                hostname: true,
                disconnectedAt: true,
                diskFreeBytes: true,
                memoryFreeBytes: true,
              },
            },
          },
          take: change.codebaseId ? 1 : 500,
        });
        for (const codebase of codebases) {
          const sessionData = {
            repo: repositoryData(codebase.repository, codebase.defaultBranch),
            agent: agentData(codebase.agent),
            codebase: {
              id: codebase.id,
              folder: codebase.folder,
              agentId: codebase.agentId,
              branch: codebase.defaultBranch,
              remoteBranches: JSON.parse(
                codebase.remoteBranchesJson,
              ) as unknown,
            },
          };
          const branches: unknown = sessionData.codebase.remoteBranches;
          if (Array.isArray(branches)) {
            for (const branch of branches.filter(
              (value): value is string => typeof value === "string",
            )) {
              await this.record(
                "CODEBASE_REMOTE_BRANCH",
                codebase.id,
                `codebase-remote-branch:${codebase.id}:${branch}`,
                sessionData,
                { cursorValue: branch, branch },
              );
            }
          }
        }
      }
    } finally {
      await stream.return?.();
    }
  }

  private async emitDiskSnapshot(
    sessionData: DiskSpaceSessionData,
    input: {
      changeId: string;
      report: boolean;
      threshold: boolean;
      cleanup?: DiskSpaceCleanupChange | null;
    },
  ): Promise<void> {
    const agentId = sessionData.agent.id;
    const session = sessionData as unknown as SessionData;
    if (input.report) {
      await this.record(
        "AGENT_DISK_REPORT",
        agentId,
        `agent-disk-report:${agentId}:${sessionData.disk.lastReportedAt ?? input.changeId}`,
        session,
        { cursorValue: sessionData.disk.lastReportedAt },
      );
    }
    if (input.threshold) {
      await this.record(
        "AGENT_DISK_THRESHOLD",
        agentId,
        `agent-disk-threshold:${agentId}:${input.changeId}`,
        session,
      );
    }
    const cursor = diskSpaceStateCursor(sessionData);
    await this.record(
      "AGENT_DISK_STATE_CHANGED",
      agentId,
      `agent-disk-state:${agentId}:${input.changeId}`,
      session,
      { cursorValue: cursor },
    );
    this.diskStateFingerprints.set(agentId, JSON.stringify(cursor));

    if (input.cleanup) {
      const cleanupSession = {
        ...session,
        cleanup: input.cleanup,
      };
      await this.record(
        "AGENT_DISK_CLEANUP_RESULT",
        agentId,
        `agent-disk-cleanup:${input.cleanup.jobId}:${input.cleanup.status}`,
        cleanupSession,
        { cleanup: input.cleanup },
      );
    }
  }

  private async observeDiskChange(
    payload: DiskSpaceChangedPayload,
  ): Promise<void> {
    if (!this.diskSpace) return;
    const { id: changeId, reason, cleanup } = payload.diskSpaceChange;
    if (payload.diskSpaceChanged === "settings") {
      const overview = await this.diskSpace.overview();
      for (const view of overview.agents) {
        await this.emitDiskSnapshot(
          diskSpaceSessionData(overview.settings, view, reason),
          { changeId, report: false, threshold: true },
        );
      }
      return;
    }
    const snapshot = await this.diskSpace.snapshot(
      payload.diskSpaceChanged,
      reason,
    );
    await this.emitDiskSnapshot(snapshot, {
      changeId,
      report: reason === "REPORT_RECEIVED",
      threshold: true,
      cleanup,
    });
  }

  private async consumeDiskSpace(): Promise<void> {
    if (!this.diskSpace) return;
    const stream = this.diskSpace.subscribe();
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        await this.observeDiskChange(payload).catch((error) =>
          console.error("Could not record disk-space workflow trigger:", error),
        );
      }
    } finally {
      await stream.return?.();
    }
  }

  private async auditDiskSpace(reconcile: boolean): Promise<void> {
    if (!this.diskSpace || !this.running) return;
    try {
      const overview = await this.diskSpace.overview();
      for (const view of overview.agents) {
        const snapshot = diskSpaceSessionData(
          overview.settings,
          view,
          reconcile ? "STARTUP_RECONCILE" : "STATE_AUDIT",
        );
        const fingerprint = JSON.stringify(diskSpaceStateCursor(snapshot));
        if (
          reconcile ||
          this.diskStateFingerprints.get(view.agent.id) !== fingerprint
        ) {
          await this.emitDiskSnapshot(snapshot, {
            changeId: randomUUID(),
            report: false,
            threshold: reconcile,
          });
        }
      }
    } catch (error) {
      console.error("Could not audit disk-space workflow state:", error);
    } finally {
      if (this.running) {
        this.diskAuditTimer = setTimeout(
          () => void this.auditDiskSpace(false),
          DISK_SPACE_POLL_INTERVAL_SECONDS * 1_000,
        );
        this.diskAuditTimer.unref?.();
      }
    }
  }

  private async consumeAgents(): Promise<void> {
    const stream = agentEventBus.iterate<{ agentChanged: { id: string } }>(
      AGENT_CHANGED_TOPIC,
    );
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const prisma = await getPrismaClient();
        const agent = await prisma.agent.findUnique({
          where: { id: payload.agentChanged.id },
        });
        if (!agent) continue;
        const connected = agent.disconnectedAt === null;
        const sessionData = {
          codebase: { agentId: agent.id },
          agent: {
            id: agent.id,
            name: agent.name,
            connected,
            diskFreeBytes: agent.diskFreeBytes,
            memoryFreeBytes: agent.memoryFreeBytes,
          },
        };
        await this.record(
          "AGENT_CONNECTION",
          agent.id,
          `agent-connection:${agent.id}:${agent.updatedAt.toISOString()}`,
          sessionData,
          { cursorValue: connected },
        );
      }
    } finally {
      await stream.return?.();
    }
  }
}
