import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import {
  ACTION_CENTER_CHANGED_TOPIC,
  APP_NOTIFICATIONS_CHANGED_TOPIC,
  BUILD_SCRIPTS_CHANGED_TOPIC,
  CLI_HEALTH_CHANGED_TOPIC,
  COMMANDS_CHANGED_TOPIC,
  CRASH_REPORTS_CHANGED_TOPIC,
  DSYMS_CHANGED_TOPIC,
  REPOSITORY_TRANSFER_CHANGED_TOPIC,
  SKILLS_CHANGED_TOPIC,
  SSE_ENDPOINTS_CHANGED_TOPIC,
  SSE_STORAGE_CHANGED_TOPIC,
  TAILSCALE_SERVE_CHANGED_TOPIC,
  TELEMETRY_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";
import { APPS_CHANGED_TOPIC } from "@/services/apps/apps.service";
import type { ActionCenterService } from "@/services/action-center";
import type { CliHealthService } from "@/services/cli-health";
import type { TailscaleServeService } from "@/services/tailscale";
import type { NotificationChange } from "@/services/notifications/notifications.service";
import type { WorkflowEventsService } from "./workflow-events.service";

export type DomainWorkflowEventServices = {
  actionCenter?: Pick<ActionCenterService, "list">;
  cliHealth?: Pick<CliHealthService, "statusForAgent">;
  tailscale?: Pick<TailscaleServeService, "overview" | "operation">;
};
type CliHealthCompletion = {
  jobId: string;
  status: string;
  error: string | null;
  finishedAt: string | null;
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Adapts public domain changes to workflow inputs without exposing storage records. */
export class DomainWorkflowEventBridge {
  private readonly streams = new Set<AsyncIterableIterator<unknown>>();
  private running = false;

  constructor(
    private readonly events: WorkflowEventsService,
    private readonly services: DomainWorkflowEventServices,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.consume<{ reason: string; ids: string[] }>(
      CRASH_REPORTS_CHANGED_TOPIC,
      (change) => this.crashes(change),
    );
    this.consume<{ reason: string; ids: string[]; uploadId?: string }>(
      DSYMS_CHANGED_TOPIC,
      (change) => this.dsyms(change),
    );
    this.consume<{ reason: string; ids: string[] }>(
      TELEMETRY_CHANGED_TOPIC,
      (change) => this.telemetry(change),
    );
    this.consume<{
      cliHealthStatusChanged: {
        agentId: string | null;
        completion?: CliHealthCompletion;
      };
    }>(CLI_HEALTH_CHANGED_TOPIC, ({ cliHealthStatusChanged }) =>
      this.cliHealth(
        cliHealthStatusChanged.agentId,
        cliHealthStatusChanged.completion,
      ),
    );
    this.consume<{ operationId?: string }>(
      TAILSCALE_SERVE_CHANGED_TOPIC,
      (change) => this.tailscale(change.operationId),
    );
    this.consume<{ repositoryTransferChanged: string }>(
      REPOSITORY_TRANSFER_CHANGED_TOPIC,
      ({ repositoryTransferChanged }) =>
        this.repositoryTransfer(repositoryTransferChanged),
    );
    this.consume<{ appsChanged: { id: string | null } }>(
      APPS_CHANGED_TOPIC,
      ({ appsChanged }) => this.app(appsChanged.id),
    );
    this.consume<{ commandsChanged: unknown }>(
      COMMANDS_CHANGED_TOPIC,
      async ({ commandsChanged }) => {
        const definition =
          commandsChanged && typeof commandsChanged === "object"
            ? (commandsChanged as Record<string, unknown>)
            : {};
        const commandDefinition = {
          id: definition.id ?? null,
          name: definition.name ?? null,
          deleted: !definition.name,
        };
        await this.record(
          "COMMAND_DEFINITION_CHANGED",
          String(commandDefinition.id ?? "catalog"),
          {
            commandDefinition,
            change: {
              reason: "CHANGED",
              ids: commandDefinition.id ? [commandDefinition.id] : [],
            },
          },
        );
      },
    );
    this.consume(BUILD_SCRIPTS_CHANGED_TOPIC, () =>
      this.record("BUILD_SCRIPT_CHANGED", "catalog", {
        change: { reason: "CHANGED", ids: [] },
      }),
    );
    this.consume<{ id?: string | null }>(SKILLS_CHANGED_TOPIC, (change) =>
      change.id
        ? Promise.resolve()
        : this.record("SKILL_DEFINITION_CHANGED", "catalog", {
            change: { reason: "CHANGED", ids: [] },
          }),
    );
    this.consume<{ notificationsChanged: NotificationChange }>(
      APP_NOTIFICATIONS_CHANGED_TOPIC,
      async ({ notificationsChanged: change }) => {
        // Workflow lifecycle already has WORKFLOW_FINISHED. Observing our own completion
        // notifications would otherwise create an unbounded workflow/notification loop.
        const item = change.notification;
        if (
          change.kind !== "CREATED" ||
          !item ||
          item.resourceKind === "WORKFLOW_RUN"
        )
          return;
        const notification = {
          id: item.id,
          typeKey: item.typeKey,
          title: item.title,
          body: item.body,
          href: item.href,
          resourceKind: item.resourceKind,
          resourceId: item.resourceId,
          createdAt: item.createdAt,
        };
        await this.record(
          "NOTIFICATION_CREATED",
          item.id,
          { notification },
          `notification-created:${item.id}`,
        );
      },
    );
    this.consume(ACTION_CENTER_CHANGED_TOPIC, () => this.actionCenter());
    this.consume<{ reason: string; ids: string[] }>(
      SSE_ENDPOINTS_CHANGED_TOPIC,
      (change) =>
        this.record("SSE_ENDPOINT_CHANGED", change.ids[0] ?? "catalog", {
          change,
        }),
    );
    this.consume<{ reason: string; ids: string[] }>(
      SSE_STORAGE_CHANGED_TOPIC,
      (change) =>
        this.record("SSE_STORAGE_CHANGED", change.ids[0] ?? "storage", {
          change,
        }),
    );
  }

  stop(): void {
    this.running = false;
    for (const stream of this.streams) void stream.return?.();
    this.streams.clear();
  }

  private consume<T>(
    topic: string,
    handle: (payload: T) => Promise<unknown>,
  ): void {
    const stream = agentEventBus.iterate<T>(topic);
    this.streams.add(stream as AsyncIterableIterator<unknown>);
    void (async () => {
      try {
        for await (const payload of stream) {
          if (!this.running) break;
          await handle(payload).catch((error) =>
            console.error(`Could not record ${topic} workflow trigger:`, error),
          );
        }
      } finally {
        this.streams.delete(stream as AsyncIterableIterator<unknown>);
        await stream.return?.();
      }
    })();
  }

  private async record(
    kind: string,
    subjectKey: string,
    sessionData: Record<string, unknown>,
    dedupeKey = `${kind}:${subjectKey}:${randomUUID()}`,
    cursorValue?: unknown,
  ): Promise<void> {
    if (!this.running) return;
    await this.events.record({
      kind,
      subjectKey,
      dedupeKey,
      payload: {
        ...sessionData,
        sessionData,
        ...(cursorValue === undefined ? {} : { cursorValue }),
      },
    });
  }

  private async crashes(change: {
    reason: string;
    ids: string[];
  }): Promise<void> {
    if (change.reason === "SETTINGS") return;
    const prisma = await getPrismaClient();
    for (const id of change.ids) {
      const crash = await prisma.crashReport.findUnique({
        where: { id },
        select: {
          id: true,
          appName: true,
          bundleId: true,
          appVersion: true,
          buildVersion: true,
          exceptionType: true,
          signal: true,
          signature: true,
          signatureTitle: true,
          status: true,
          statusMessage: true,
          symbolicatedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      await this.record(
        "CRASH_REPORT_CHANGED",
        id,
        { crash: crash ?? { id, deleted: true }, change },
        `crash-change:${id}:${change.reason}:${crash?.updatedAt.toISOString() ?? "deleted"}`,
      );
    }
  }

  private async dsyms(change: {
    reason: string;
    ids: string[];
    uploadId?: string;
  }): Promise<void> {
    const prisma = await getPrismaClient();
    if (change.uploadId) {
      const upload = await prisma.dsymUpload.findUnique({
        where: { id: change.uploadId },
        select: {
          id: true,
          filename: true,
          status: true,
          error: true,
          source: true,
          projectName: true,
          buildId: true,
          linkedBuildId: true,
          updatedAt: true,
        },
      });
      await this.record(
        "DSYM_CHANGED",
        `upload:${change.uploadId}`,
        {
          dsym: {
            id: null,
            entityKind: "UPLOAD",
            uploadId: change.uploadId,
            status: upload?.status ?? "DELETED",
            upload: upload ?? { id: change.uploadId, deleted: true },
          },
          change,
        },
        `dsym-upload-change:${change.uploadId}:${change.reason}:${upload?.updatedAt.toISOString() ?? "deleted"}`,
      );
    }
    // Upload progress notifications intentionally have no dSYM ids before indexing.
    // Preserve that catalog signal rather than replaying every historical upload.
    if (!change.ids.length && !change.uploadId) {
      await this.record("DSYM_CHANGED", "uploads", {
        dsym: { id: null, uploadChanged: true },
        change,
      });
      return;
    }
    for (const id of change.ids) {
      const dsym = await prisma.dsym.findUnique({
        where: { id },
        select: {
          id: true,
          uploadId: true,
          bundleName: true,
          binaryName: true,
          bundleIdentifier: true,
          shortVersion: true,
          bundleVersion: true,
          createdAt: true,
          upload: { select: { status: true, error: true, updatedAt: true } },
        },
      });
      await this.record(
        "DSYM_CHANGED",
        id,
        {
          dsym: dsym
            ? { ...dsym, entityKind: "DSYM", status: dsym.upload.status }
            : { id, entityKind: "DSYM", deleted: true, status: "DELETED" },
          change,
        },
        `dsym-change:${id}:${change.reason}:${dsym?.upload.updatedAt.toISOString() ?? "deleted"}`,
      );
    }
  }

  private async telemetry(change: {
    reason: string;
    ids: string[];
  }): Promise<void> {
    if (change.reason !== "INGESTED" || !change.ids.length) return;
    const prisma = await getPrismaClient();
    const entries = await prisma.telemetryEntry.findMany({
      where: { id: { in: change.ids } },
      select: {
        id: true,
        entryType: true,
        clientTime: true,
        receivedAt: true,
        message: true,
        level: true,
        category: true,
        eventName: true,
        eventKind: true,
        screenName: true,
        buildId: true,
        sessionId: true,
      },
    });
    for (const telemetry of entries) {
      const kind =
        telemetry.entryType === "CONSOLE"
          ? "TELEMETRY_CONSOLE_INGESTED"
          : telemetry.entryType === "ANALYTICS"
            ? "TELEMETRY_ANALYTICS_INGESTED"
            : null;
      if (kind)
        await this.record(
          kind,
          telemetry.id,
          { telemetry },
          `telemetry-ingested:${telemetry.id}`,
        );
    }
  }

  private async cliHealth(
    agentId: string | null,
    completion?: CliHealthCompletion,
  ): Promise<void> {
    if (!agentId || !this.services.cliHealth) return;
    const current = await this.services.cliHealth.statusForAgent(agentId);
    if (!completion && (current.activeJobId || !current.lastCheckedAt)) return;
    const cliHealth = completion
      ? {
          ...current,
          jobId: completion.jobId,
          jobStatus: completion.status,
          error: completion.error,
          lastCheckedAt: completion.finishedAt,
          ...(completion.status !== "SUCCEEDED"
            ? { overall: "ISSUES", results: [] }
            : {}),
        }
      : current;
    await this.record(
      "CLI_HEALTH_RESULT",
      agentId,
      { cliHealth, agent: { id: agentId, name: cliHealth.name } },
      `cli-health-result:${agentId}:${completion?.jobId ?? cliHealth.lastCheckedAt}`,
    );
  }

  private async tailscale(operationId?: string): Promise<void> {
    if (!this.services.tailscale) return;
    const source = await this.services.tailscale.overview();
    const overview = {
      agents: source.agents.map((item) => ({
        agentId: item.agent.id,
        name: item.agent.name,
        supported: item.supported,
        dnsHostname: item.dnsHostname,
        ipv4: item.ipv4,
        ipv6: item.ipv6,
        backendState: item.backendState,
        observedRoutes: item.observedRoutes,
        error: item.error,
      })),
      templates: source.templates.map((item) => ({
        id: item.id,
        name: item.name,
        revision: item.revision,
        lifecycle: item.lifecycle,
        route: item.route,
        assignments: item.assignments.map((assignment) => ({
          agentId: assignment.agentId,
          desiredEnabled: assignment.desiredEnabled,
          observedEnabled: assignment.observedEnabled,
          status: assignment.status,
          error: assignment.lastError,
        })),
      })),
    };
    const revision = hash(overview);
    await this.record(
      "TAILSCALE_SERVE_STATE_CHANGED",
      "fleet",
      { tailscale: { overview } },
      undefined,
      revision,
    );
    if (!operationId) return;
    const operationSource =
      await this.services.tailscale.operation(operationId);
    if (!operationSource?.finishedAt) return;
    const operation = {
      id: operationSource.id,
      kind: operationSource.kind,
      status: operationSource.status,
      templateId: operationSource.templateId,
      finishedAt: operationSource.finishedAt,
      agents: operationSource.agents.map((item) => ({
        agentId: item.agentId,
        status: item.status,
        error: item.error,
      })),
    };
    await this.record(
      "TAILSCALE_SERVE_OPERATION_RESULT",
      operationId,
      {
        tailscale: {
          operationId,
          status: operation.status,
          templateId: operation.templateId,
          operation,
        },
      },
      `tailscale-result:${operationId}:${operation.status}:${operation.finishedAt.toISOString()}`,
    );
  }

  private async repositoryTransfer(id: string): Promise<void> {
    const prisma = await getPrismaClient();
    const repositoryTransfer =
      await prisma.repositoryTransferOperation.findUnique({
        where: { id },
        select: {
          id: true,
          kind: true,
          status: true,
          appId: true,
          finishedAt: true,
          updatedAt: true,
          items: {
            select: {
              id: true,
              repositoryId: true,
              agentId: true,
              codebaseId: true,
              status: true,
              error: true,
            },
          },
        },
      });
    if (!repositoryTransfer?.finishedAt) return;
    await this.record(
      "REPOSITORY_TRANSFER_RESULT",
      id,
      { repositoryTransfer },
      `repository-transfer-result:${id}:${repositoryTransfer.status}:${repositoryTransfer.finishedAt.toISOString()}`,
    );
  }

  private async app(id: string | null): Promise<void> {
    const prisma = await getPrismaClient();
    const app = id
      ? await prisma.app.findUnique({
          where: { id },
          select: { id: true, name: true, description: true, updatedAt: true },
        })
      : null;
    await this.record("APP_CHANGED", id ?? "catalog", {
      app: app ?? { id, deleted: Boolean(id) },
      change: {
        reason: app ? "SAVED" : id ? "DELETED" : "CHANGED",
        ids: id ? [id] : [],
      },
    });
  }

  private async actionCenter(): Promise<void> {
    if (!this.services.actionCenter) return;
    const result = await this.services.actionCenter.list({
      first: 200,
      resourceKinds: [
        "PLAN",
        "SESSION",
        "BUILD",
        "PULL_REQUEST",
        "MERGE_REQUEST",
      ],
    });
    const items = result.items
      .filter((item) => item.reason !== "ACTIVE")
      .map((item) => ({
        key: item.key,
        resourceKind: item.resourceKind,
        resourceId: item.resourceId,
        reason: item.reason,
        status: item.status,
        label: item.label,
        error: item.error,
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
    const actionCenter = {
      count: items.length,
      items,
      hasMore: Boolean(result.nextCursor),
    };
    await this.record(
      "ACTION_CENTER_CHANGED",
      "attention",
      { actionCenter },
      undefined,
      hash(actionCenter),
    );
  }
}
