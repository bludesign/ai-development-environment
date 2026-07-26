import "server-only";

import { randomUUID } from "node:crypto";

import { DISK_SPACE_POLL_INTERVAL_SECONDS } from "@ai-development-environment/agent-contract/disk-space";
import { WORKTREE_AUTO_SYNC_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";

import {
  AGENT_CHANGED_TOPIC,
  BUILD_DATA_CHANGED_TOPIC,
  BUILDS_CHANGED_TOPIC,
  CODEBASE_CHANGED_TOPIC,
  COMMAND_RUN_OUTPUT_CHANGED_TOPIC,
  COMMAND_RUNS_CHANGED_TOPIC,
  GITHUB_PIPELINE_STATUS_CHANGED_TOPIC,
  IOS_DEVICES_CHANGED_TOPIC,
  MODEL_COST_CATALOG_CHANGED_TOPIC,
  POLLING_CHANGED_TOPIC,
  PUSH_NOTIFICATIONS_CHANGED_TOPIC,
  RUNS_CHANGED_TOPIC,
  SIGNING_ASSETS_CHANGED_TOPIC,
  SKILLS_CHANGED_TOPIC,
  TOOL_CALL_AUDIT_CHANGED_TOPIC,
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
import type { GitHubPipelineStatusChangeView } from "@/services/github";
import type { BuildDataService } from "@/services/build-data";
import type { CommandsService } from "@/services/commands";
import type { CredentialService } from "@/services/credentials";
import type { IosDevicesService } from "@/services/ios-devices";
import type { PollingService } from "@/services/polling";
import type { PushNotificationsService } from "@/services/push-notifications";
import type { SigningAssetsService } from "@/services/signing-assets";
import type { SkillsService } from "@/services/skills";

import type { WorkflowEventsService } from "./workflow-events.service";

type SessionData = Record<string, unknown>;

export type WorkflowEventBridgeDomains = {
  buildData?: Pick<BuildDataService, "getCollection">;
  commands?: Pick<CommandsService, "getRun">;
  credentials?: Pick<CredentialService, "status">;
  iosDevices?: Pick<IosDevicesService, "device">;
  polling?: Pick<PollingService, "list">;
  pushNotifications?: Pick<PushNotificationsService, "history">;
  signingAssets?: Pick<SigningAssetsService, "operations" | "profiles">;
  skills?: Pick<SkillsService, "getRun">;
};

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
    private readonly domains: WorkflowEventBridgeDomains = {},
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
    void this.consumePipelineStatuses();
    void this.consumeCommandRuns();
    void this.consumeCommandOutput();
    void this.consumeSkillSyncs();
    void this.consumeIosDevices();
    void this.consumeSigningAssets();
    void this.consumePushNotifications();
    void this.consumeBuildData();
    void this.consumePollingOperations();
    void this.consumeModelCosts();
    void this.consumeToolCalls();
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
    if (job.kind === WORKTREE_AUTO_SYNC_JOB_KIND && job.worktreeId) {
      const targetSessionData = await this.worktreeSessionData(
        job.worktreeId,
        true,
      );
      await this.record(
        "WORKTREE_AUTOMATION_RESULT",
        job.worktreeId,
        `worktree-automation:${job.id}:${job.status}`,
        mergeSessionData(targetSessionData, {
          worktree: { id: job.worktreeId },
          automation: {
            jobId: job.id,
            status: job.status,
            error: job.error,
            result: parsed(job.resultJson ?? "{}"),
          },
        }),
        { cursorValue: `${job.id}:${job.status}` },
      );
    }
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

  private async consumePipelineStatuses(): Promise<void> {
    const stream = agentEventBus.iterate<{
      githubPipelineStatusChanged: GitHubPipelineStatusChangeView;
    }>(GITHUB_PIPELINE_STATUS_CHANGED_TOPIC);
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const change = payload.githubPipelineStatusChanged;
        const snapshot = change.snapshot;
        const pipeline = change.changedPipeline ?? {
          status: snapshot.pipelineStatus,
        };
        await this.record(
          "GITHUB_PIPELINE_STATUS_CHANGED",
          `${snapshot.repositoryGithubId}:${snapshot.headSha}`,
          `github-pipeline:${snapshot.repositoryGithubId}:${snapshot.headSha}:${snapshot.revision}`,
          {
            repo: {
              githubId: snapshot.repositoryGithubId,
              nameWithOwner: snapshot.repositoryNameWithOwner,
              url: snapshot.repositoryUrl,
            },
            pipeline: {
              ...pipeline,
              headSha: snapshot.headSha,
              aggregateStatus: snapshot.pipelineStatus,
              revision: snapshot.revision,
            },
          },
          { cursorValue: snapshot.revision },
        ).catch((error) =>
          console.error("Could not record GitHub pipeline trigger:", error),
        );
      }
    } finally {
      await stream.return?.();
    }
  }

  private async consumeCommandRuns(): Promise<void> {
    const stream = agentEventBus.iterate<{
      commandRunsChanged: { id: string };
    }>(COMMAND_RUNS_CHANGED_TOPIC);
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const service = this.domains.commands;
        if (!service) continue;
        const run = await service.getRun(payload.commandRunsChanged.id);
        if (
          !run ||
          !new Set(["SUCCEEDED", "FAILED", "CANCELLED"]).has(run.status)
        ) {
          continue;
        }
        const target = await this.worktreeSessionData(run.worktreeId, true);
        const sessionData = mergeSessionData(target, {
          command: {
            id: run.id,
            commandId: run.commandId,
            name: run.snapshotName,
            status: run.status,
            exitCode: run.exitCode,
            signal: run.signal,
            error: run.error,
            finishedAt: run.finishedAt?.toISOString() ?? null,
          },
          agent: { id: run.agentId, name: run.agentName },
          ...(run.worktreeId ? { worktree: { id: run.worktreeId } } : {}),
        });
        const terminalAt = run.finishedAt?.toISOString() ?? "terminal";
        await this.record(
          "COMMAND_RUN_RESULT",
          run.id,
          `command-result:${run.id}:${run.status}:${terminalAt}`,
          sessionData,
          { cursorValue: `${run.status}:${terminalAt}` },
        ).catch((error) =>
          console.error("Could not record command result trigger:", error),
        );
      }
    } finally {
      await stream.return?.();
    }
  }

  private async consumeCommandOutput(): Promise<void> {
    const stream = agentEventBus.iterate<{
      commandRunOutputAdded: {
        id: string;
        runId: string;
        attemptNumber: number;
        sequence: number;
        stream: string;
        dataBase64: string;
        createdAt: Date;
      };
    }>(COMMAND_RUN_OUTPUT_CHANGED_TOPIC);
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const chunk = payload.commandRunOutputAdded;
        const data = Buffer.from(chunk.dataBase64, "base64").toString("utf8");
        await this.record(
          "COMMAND_OUTPUT_MATCH",
          chunk.runId,
          `command-output:${chunk.id}`,
          {
            command: { id: chunk.runId },
            output: {
              data,
              stream: chunk.stream,
              attempt: chunk.attemptNumber,
              sequence: chunk.sequence,
            },
          },
          { cursorValue: chunk.id },
        ).catch((error) =>
          console.error("Could not record command output trigger:", error),
        );
      }
    } finally {
      await stream.return?.();
    }
  }

  private async consumeSkillSyncs(): Promise<void> {
    const stream = agentEventBus.iterate<{ id: string | null }>(
      SKILLS_CHANGED_TOPIC,
    );
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const service = this.domains.skills;
        if (!service || !payload.id) continue;
        const run = await service.getRun(payload.id);
        if (!run) continue;
        const conflicts = run.items
          .filter((item) => item.status === "BLOCKED")
          .map((item) => ({
            id: item.id,
            skillId: item.skillId,
            skillName: item.skill?.name ?? null,
            direction: item.direction,
            error: item.error,
          }));
        const sessionData = {
          skillSync: {
            id: run.id,
            kind: run.kind,
            status: run.status,
            error: run.error,
            conflictCount: conflicts.length,
            conflicts,
            updatedAt: run.updatedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
          },
          ...(run.groupId ? { skill: { groupId: run.groupId } } : {}),
        };
        if (run.status === "NEEDS_RESOLUTION" || conflicts.length) {
          await this.record(
            "SKILL_SYNC_CONFLICT",
            run.id,
            `skill-conflict:${run.id}:${run.updatedAt.toISOString()}`,
            sessionData,
            { cursorValue: run.updatedAt.toISOString() },
          );
        }
        if (new Set(["READY", "PARTIAL", "SUCCEEDED"]).has(run.status)) {
          await this.record(
            "SKILL_SYNC_RESULT",
            run.id,
            `skill-result:${run.id}:${run.status}:${run.updatedAt.toISOString()}`,
            sessionData,
            { cursorValue: `${run.status}:${run.updatedAt.toISOString()}` },
          );
        }
      }
    } finally {
      await stream.return?.();
    }
  }

  private async consumeIosDevices(): Promise<void> {
    const stream = agentEventBus.iterate<{ id: string | null }>(
      IOS_DEVICES_CHANGED_TOPIC,
    );
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const service = this.domains.iosDevices;
        if (!service || !payload.id) continue;
        const device = await service.device(payload.id);
        if (!device) continue;
        const sessionData = {
          device: {
            id: device.id,
            udid: device.udid,
            name: device.displayName,
            product: device.product,
            osVersion: device.osVersion,
            status: device.status,
            error: device.registrationError,
            updatedAt: device.updatedAt.toISOString(),
          },
        };
        await this.record(
          "IOS_DEVICE_ENROLLED",
          device.id,
          `ios-device-enrolled:${device.id}:${device.createdAt.toISOString()}`,
          sessionData,
          { cursorValue: device.createdAt.toISOString() },
        );
        if (
          new Set(["REGISTERED", "REGISTRATION_FAILED", "REJECTED"]).has(
            device.status,
          )
        ) {
          await this.record(
            "IOS_DEVICE_REGISTRATION_RESULT",
            device.id,
            `ios-device-registration:${device.id}:${device.status}:${device.updatedAt.toISOString()}`,
            sessionData,
            {
              cursorValue: `${device.status}:${device.updatedAt.toISOString()}`,
            },
          );
        }
      }
    } finally {
      await stream.return?.();
    }
  }

  private async consumeSigningAssets(): Promise<void> {
    const stream = agentEventBus.iterate<{ changed: boolean }>(
      SIGNING_ASSETS_CHANGED_TOPIC,
    );
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        if (!payload.changed) continue;
        const service = this.domains.signingAssets;
        if (!service) continue;
        const [operations, profiles] = await Promise.all([
          service.operations(200),
          service.profiles(),
        ]);
        for (const operation of operations.filter((item) => item.finishedAt)) {
          const sessionData = {
            signingOperation: {
              id: operation.id,
              kind: operation.kind,
              status: operation.status,
              assetKey: operation.assetKey,
              error: operation.error,
              finishedAt: operation.finishedAt?.toISOString() ?? null,
            },
            ...(operation.assetKey
              ? { signingProfile: { id: operation.assetKey } }
              : {}),
          };
          await this.record(
            "SIGNING_OPERATION_RESULT",
            operation.id,
            `signing-operation:${operation.id}:${operation.status}:${operation.updatedAt.toISOString()}`,
            sessionData,
            {
              cursorValue: `${operation.status}:${operation.updatedAt.toISOString()}`,
            },
          );
        }
        for (const profile of profiles.filter((item) => item.expiresAt)) {
          const expiresAt = profile.expiresAt!;
          await this.record(
            "SIGNING_ASSET_EXPIRING",
            profile.id,
            `signing-expiry:${profile.id}:${expiresAt}`,
            { signingProfile: { ...profile, id: profile.id } },
            {
              cursorValue: expiresAt,
              expiresInDays: Math.ceil(
                (new Date(expiresAt).getTime() - Date.now()) / 86_400_000,
              ),
            },
          );
        }
      }
    } finally {
      await stream.return?.();
    }
  }

  private async consumePushNotifications(): Promise<void> {
    const stream = agentEventBus.iterate<{ changed: boolean }>(
      PUSH_NOTIFICATIONS_CHANGED_TOPIC,
    );
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        if (!payload.changed) continue;
        const service = this.domains.pushNotifications;
        if (!service) continue;
        const batches = await service.history(200);
        for (const batch of batches.filter(
          (item) => !new Set(["DRAFT", "QUEUED", "SENDING"]).has(item.status),
        )) {
          const updatedAt = batch.updatedAt.toISOString();
          await this.record(
            "PUSH_NOTIFICATION_RESULT",
            batch.id,
            `push-result:${batch.id}:${batch.status}:${updatedAt}`,
            {
              pushBatch: {
                id: batch.id,
                status: batch.status,
                targetMode: batch.targetMode,
                deliveryCount: batch.deliveries.length,
                updatedAt,
              },
            },
            { cursorValue: `${batch.status}:${updatedAt}` },
          );
        }
      }
    } finally {
      await stream.return?.();
    }
  }

  private async consumeBuildData(): Promise<void> {
    const stream = agentEventBus.iterate<{
      buildDataCollectionChanged: { id: string };
    }>(BUILD_DATA_CHANGED_TOPIC);
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const service = this.domains.buildData;
        if (!service) continue;
        const collection = await service.getCollection(
          payload.buildDataCollectionChanged.id,
        );
        if (!collection || collection.status !== "COMPLETED") continue;
        const totalBytes = collection.entries.reduce(
          (total, entry) => total + (entry.sizeBytes ?? 0),
          0,
        );
        const sessionData = {
          buildData: {
            id: collection.id,
            status: collection.status,
            finishedAt: collection.finishedAt,
            totalBytes,
            entryCount: collection.entries.length,
            successfulAgentCount: collection.progress.successfulCount,
          },
        };
        const revision = collection.finishedAt ?? collection.deadlineAt;
        await this.record(
          "BUILD_DATA_THRESHOLD",
          collection.id,
          `build-data-threshold:${collection.id}:${revision}`,
          sessionData,
          { cursorValue: totalBytes },
        );
        await this.record(
          "BUILD_DATA_CLEANUP_RESULT",
          collection.id,
          `build-data-result:${collection.id}:${revision}`,
          sessionData,
          { cursorValue: revision },
        );
      }
    } finally {
      await stream.return?.();
    }
  }

  private async consumePollingOperations(): Promise<void> {
    const stream = agentEventBus.iterate<{
      pollingOperationChanged: string;
    }>(POLLING_CHANGED_TOPIC);
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const service = this.domains.polling;
        if (!service) continue;
        const operation = (await service.list()).find(
          (item) => item.id === payload.pollingOperationChanged,
        );
        if (!operation) continue;
        const revision =
          operation.lastCompletedAt ??
          operation.lastStartedAt ??
          operation.nextScheduledAt ??
          operation.status;
        await this.record(
          "POLLING_OPERATION_STATE",
          operation.id,
          `polling-state:${operation.id}:${operation.status}:${revision}`,
          { polling: operation },
          { cursorValue: `${operation.status}:${revision}` },
        ).catch((error) =>
          console.error("Could not record polling operation trigger:", error),
        );
        const credentialStore = await this.domains.credentials?.status();
        if (credentialStore && credentialStore.state !== "READY") {
          const warningCodes = credentialStore.warnings.map(({ code }) => code);
          await this.record(
            "CREDENTIAL_STORE_DEGRADED",
            credentialStore.storageType,
            `credential-store:${credentialStore.state}:${warningCodes.join(",")}`,
            { credentialStore },
            {
              cursorValue: {
                state: credentialStore.state,
                warningCodes,
                mismatchCount: credentialStore.mismatchCount,
              },
            },
          );
        }
      }
    } finally {
      await stream.return?.();
    }
  }

  private async consumeModelCosts(): Promise<void> {
    const stream = agentEventBus.iterate<{
      catalog: {
        url: string;
        fetchedAt: string | null;
        entryCount: number;
        error: string | null;
      };
    }>(MODEL_COST_CATALOG_CHANGED_TOPIC);
    try {
      for await (const { catalog } of stream) {
        if (!this.running) break;
        const revision =
          catalog.fetchedAt ?? `${catalog.url}:${catalog.error ?? "pending"}`;
        await this.record(
          "MODEL_COST_CATALOG_CHANGED",
          catalog.url,
          `model-costs:${catalog.url}:${revision}`,
          { modelCosts: catalog },
          { cursorValue: revision },
        );
      }
    } finally {
      await stream.return?.();
    }
  }

  private async consumeToolCalls(): Promise<void> {
    const stream = agentEventBus.iterate<{
      toolCallAuditChanged: { id: string };
    }>(TOOL_CALL_AUDIT_CHANGED_TOPIC);
    try {
      for await (const payload of stream) {
        if (!this.running) break;
        const prisma = await getPrismaClient();
        const audit = await prisma.toolCallAudit.findUnique({
          where: { id: payload.toolCallAuditChanged.id },
        });
        if (!audit || audit.resultStatus === "RUNNING") continue;
        const callerRunId = audit.caller.startsWith("workflow:")
          ? audit.caller.slice("workflow:".length)
          : null;
        const workflowRun = callerRunId
          ? await prisma.workflowRun.findUnique({
              where: { id: callerRunId },
              select: { id: true, workflowId: true },
            })
          : null;
        const correlatedAttempt = workflowRun
          ? null
          : await prisma.workflowStepAttempt.findUnique({
              where: { id: audit.correlationId },
              select: {
                run: { select: { id: true, workflowId: true } },
              },
            });
        const owningRun = workflowRun ?? correlatedAttempt?.run ?? null;
        const finishedAt = audit.finishedAt?.toISOString() ?? "unfinished";
        await this.record(
          "TOOL_CALL_RESULT",
          audit.id,
          `tool-call:${audit.id}:${audit.resultStatus}:${finishedAt}`,
          {
            toolCall: {
              id: audit.id,
              correlationId: audit.correlationId,
              caller: audit.caller,
              source: audit.source,
              groupId: audit.groupId,
              toolName: audit.toolName,
              argumentsSha256: audit.argumentsSha256,
              resultStatus: audit.resultStatus,
              durationMs: audit.durationMs,
              finishedAt: audit.finishedAt?.toISOString() ?? null,
            },
          },
          {
            cursorValue: `${audit.resultStatus}:${finishedAt}`,
            ...(owningRun
              ? {
                  workflowCorrelation: {
                    workflowId: owningRun.workflowId,
                    runId: owningRun.id,
                  },
                }
              : {}),
          },
        );
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
    syncState: string;
    pushStatus: string;
    statusError: string | null;
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
        syncState: worktree.syncState,
        pushStatus: worktree.pushStatus,
        statusError: worktree.statusError,
        baseBehind: worktree.baseBehind,
        dirty,
        missingAt: worktree.missingAt?.toISOString() ?? null,
        dirtySince: dirty ? worktree.updatedAt.toISOString() : null,
      },
    });
    const common = { cursorValue: observedAt.toISOString() };
    await this.record(
      "WORKTREE_SYNC_STATE_CHANGED",
      worktree.id,
      `worktree-sync:${worktree.id}:${worktree.syncState}:${observedAt.toISOString()}`,
      sessionData,
      { cursorValue: worktree.syncState },
    );
    await this.record(
      "WORKTREE_CLEAN",
      worktree.id,
      `worktree-clean:${worktree.id}:${observedAt.toISOString()}`,
      sessionData,
      { cursorValue: dirty },
    );
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
              syncState: codebase.syncState,
              availability: codebase.availability,
              statusError: codebase.statusError,
              lastFetchError: codebase.lastFetchError,
              remoteBranches: JSON.parse(
                codebase.remoteBranchesJson,
              ) as unknown,
            },
          };
          const revision = (
            codebase.lastCheckedAt ?? codebase.updatedAt
          ).toISOString();
          await this.record(
            "CODEBASE_SYNC_STATE_CHANGED",
            codebase.id,
            `codebase-sync:${codebase.id}:${codebase.syncState}:${revision}`,
            sessionData,
            { cursorValue: codebase.syncState },
          );
          if (codebase.statusError || codebase.lastFetchError) {
            await this.record(
              "CODEBASE_OPERATION_FAILED",
              codebase.id,
              `codebase-failed:${codebase.id}:${revision}`,
              sessionData,
              {
                cursorValue: revision,
                error: codebase.statusError ?? codebase.lastFetchError,
              },
            );
          }
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
        await this.record(
          "AGENT_RESOURCE_THRESHOLD",
          agent.id,
          `agent-resource:${agent.id}:${agent.updatedAt.toISOString()}`,
          sessionData,
          {
            cursorValue: {
              diskFreeBytes: agent.diskFreeBytes,
              memoryFreeBytes: agent.memoryFreeBytes,
            },
          },
        );
        await this.record(
          "AGENT_VERSION_CHANGED",
          agent.id,
          `agent-version:${agent.id}:${agent.version}`,
          {
            ...sessionData,
            agent: {
              ...sessionData.agent,
              version: agent.version,
              osVersion: agent.osVersion,
              architecture: agent.architecture,
            },
          },
          { cursorValue: agent.version },
        );
      }
    } finally {
      await stream.return?.();
    }
  }
}
