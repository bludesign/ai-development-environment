import { randomUUID } from "node:crypto";

import {
  TAILSCALE_SERVE_INSPECT_JOB_KIND,
  TAILSCALE_SERVE_REMOVE_JOB_KIND,
  TAILSCALE_SERVE_UPSERT_JOB_KIND,
  parseTailscaleServeRoute,
  tailscaleListenerKey,
  tailscaleServeFingerprint,
  type TailscaleServeJobResult,
  type TailscaleServeRoute,
  type TailscaleServeSnapshot,
} from "@ai-development-environment/agent-contract/tailscale";

import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import {
  AgentControlService,
  agentEventBus,
  TAILSCALE_SERVE_CHANGED_TOPIC,
  tailscaleServeOperationChangedTopic,
} from "@/services/agent-control";

const TERMINAL_OPERATION_ITEM_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "UNSUPPORTED",
]);

const overviewInclude = {
  assignments: {
    include: { agent: true },
    orderBy: { agent: { name: "asc" as const } },
  },
} as const;

const operationInclude = {
  agents: {
    include: { agent: true, job: true },
    orderBy: { agent: { name: "asc" as const } },
  },
} as const;

export type TailscaleTemplateInput = {
  id?: string | null;
  expectedRevision?: number | null;
  name: string;
  protocol: string;
  listenPort: number;
  mountPath?: string | null;
  destinationProtocol: string;
  destinationPort: number;
  destinationPath?: string | null;
  funnel: boolean;
  appCapabilities?: string[] | null;
  proxyProtocol: string;
  assignments: Array<{ agentId: string; enabled: boolean }>;
};

function jsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function jsonRoutes(value: string): TailscaleServeRoute[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.flatMap((item) => {
          try {
            return [parseTailscaleServeRoute(item)];
          } catch {
            return [];
          }
        })
      : [];
  } catch {
    return [];
  }
}

function capabilities(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function routeFromTemplate(template: {
  protocol: string;
  listenPort: number;
  mountPath: string;
  destinationProtocol: string;
  destinationPort: number;
  destinationPath: string;
  funnel: boolean;
  appCapabilitiesJson: string;
  proxyProtocol: string;
}): TailscaleServeRoute {
  return parseTailscaleServeRoute({
    protocol: template.protocol,
    listenPort: template.listenPort,
    mountPath: template.mountPath,
    destination: {
      protocol: template.destinationProtocol,
      port: template.destinationPort,
      path: template.destinationPath,
    },
    funnel: template.funnel,
    appCapabilities: jsonArray(template.appCapabilitiesJson),
    proxyProtocol: template.proxyProtocol,
  });
}

function routeFromInput(input: TailscaleTemplateInput): TailscaleServeRoute {
  return parseTailscaleServeRoute({
    protocol: input.protocol,
    listenPort: input.listenPort,
    mountPath: input.mountPath ?? "/",
    destination: {
      protocol: input.destinationProtocol,
      port: input.destinationPort,
      path: input.destinationPath ?? "",
    },
    funnel: input.funnel,
    appCapabilities: input.appCapabilities ?? [],
    proxyProtocol: input.proxyProtocol,
  });
}

function routeData(route: TailscaleServeRoute) {
  return {
    protocol: route.protocol,
    listenPort: route.listenPort,
    mountPath: route.mountPath,
    destinationProtocol: route.destination.protocol,
    destinationPort: route.destination.port,
    destinationPath: route.destination.path,
    funnel: route.funnel,
    appCapabilitiesJson: JSON.stringify(route.appCapabilities),
    proxyProtocol: route.proxyProtocol,
    fingerprint: tailscaleServeFingerprint(route),
  };
}

function validName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 200) {
    throw new Error(
      "Tailscale Serve template name must be 1 through 200 characters",
    );
  }
  return name;
}

function operationStatusFromJob(status: string): string {
  return status === "SUCCEEDED"
    ? "SUCCEEDED"
    : status === "CANCELLED"
      ? "CANCELLED"
      : status === "TIMED_OUT"
        ? "TIMED_OUT"
        : "FAILED";
}

function mutationRevision(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const revision = (value as Record<string, unknown>).revision;
  return Number.isInteger(revision) ? (revision as number) : null;
}

export function parseTailscaleServeJobResult(
  value: string | null,
): TailscaleServeJobResult {
  if (!value) throw new Error("Tailscale job did not return a snapshot");
  const parsed = JSON.parse(value) as Partial<TailscaleServeJobResult>;
  if (!parsed.snapshot || typeof parsed.snapshot !== "object") {
    throw new Error("Tailscale job returned an invalid snapshot");
  }
  const snapshot = parsed.snapshot as TailscaleServeSnapshot;
  if (!snapshot.identity || !Array.isArray(snapshot.routes)) {
    throw new Error("Tailscale job returned an invalid snapshot");
  }
  return {
    exitCode: parsed.exitCode ?? null,
    signal: parsed.signal ?? null,
    timedOut: parsed.timedOut === true,
    cancelled: parsed.cancelled === true,
    snapshot: {
      identity: {
        dnsHostname:
          typeof snapshot.identity.dnsHostname === "string"
            ? snapshot.identity.dnsHostname
            : null,
        ipv4: Array.isArray(snapshot.identity.ipv4)
          ? snapshot.identity.ipv4.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        ipv6: Array.isArray(snapshot.identity.ipv6)
          ? snapshot.identity.ipv6.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        backendState:
          typeof snapshot.identity.backendState === "string"
            ? snapshot.identity.backendState
            : "Unknown",
      },
      routes: snapshot.routes.map(parseTailscaleServeRoute),
      inspectedAt: new Date(snapshot.inspectedAt).toISOString(),
    },
  };
}

export function tailscaleRoutesConflict(
  existing: TailscaleServeRoute,
  route: TailscaleServeRoute,
): boolean {
  if (existing.listenPort !== route.listenPort) return false;
  const bothWeb =
    ["HTTP", "HTTPS"].includes(existing.protocol) &&
    ["HTTP", "HTTPS"].includes(route.protocol);
  return !(
    bothWeb &&
    existing.protocol === route.protocol &&
    existing.funnel === route.funnel &&
    existing.mountPath !== route.mountPath
  );
}

export class TailscaleServeService {
  constructor(private readonly agentControl: AgentControlService) {
    for (const kind of [
      TAILSCALE_SERVE_INSPECT_JOB_KIND,
      TAILSCALE_SERVE_UPSERT_JOB_KIND,
      TAILSCALE_SERVE_REMOVE_JOB_KIND,
    ]) {
      this.agentControl.registerCompletionHandler(kind, (job) =>
        this.projectCompletion(job),
      );
    }
  }

  private publish(operationId?: string): void {
    agentEventBus.publish(TAILSCALE_SERVE_CHANGED_TOPIC, {
      tailscaleServeOverviewChanged: true,
    });
    if (operationId) {
      agentEventBus.publish(tailscaleServeOperationChangedTopic(operationId), {
        tailscaleServeOperationChanged: operationId,
      });
    }
  }

  async overview() {
    const prisma = await getPrismaClient();
    const [agents, templates] = await Promise.all([
      prisma.agent.findMany({
        include: { tailscaleState: true },
        orderBy: { name: "asc" },
      }),
      prisma.tailscaleServeTemplate.findMany({
        include: overviewInclude,
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return {
      agents: agents.map((agent) => ({
        agent,
        supported: capabilities(agent.capabilitiesJson).includes(
          TAILSCALE_SERVE_INSPECT_JOB_KIND,
        ),
        dnsHostname: agent.tailscaleState?.dnsHostname ?? null,
        ipv4: jsonArray(agent.tailscaleState?.ipv4Json ?? "[]"),
        ipv6: jsonArray(agent.tailscaleState?.ipv6Json ?? "[]"),
        backendState: agent.tailscaleState?.backendState ?? "Unknown",
        observedRoutes: jsonRoutes(agent.tailscaleState?.routesJson ?? "[]"),
        lastInspectedAt:
          agent.tailscaleState?.lastInspectedAt?.toISOString() ?? null,
        error: agent.tailscaleState?.lastError ?? null,
      })),
      templates: templates.map((template) => ({
        ...template,
        route: routeFromTemplate(template),
      })),
      updatedAt: new Date().toISOString(),
    };
  }

  async operation(id: string) {
    const prisma = await getPrismaClient();
    return prisma.tailscaleServeOperation.findUnique({
      where: { id },
      include: operationInclude,
    });
  }

  subscribeOverview() {
    return agentEventBus.iterate(TAILSCALE_SERVE_CHANGED_TOPIC);
  }

  subscribeOperation(id: string) {
    return agentEventBus.iterate(tailscaleServeOperationChangedTopic(id));
  }

  private async operationForRequest(requestId: string) {
    const prisma = await getPrismaClient();
    return prisma.tailscaleServeOperation.findUnique({
      where: { requestId },
      include: operationInclude,
    });
  }

  private async createOperation(
    kind: string,
    requestId: string,
    agentIds: string[],
    templateId?: string | null,
  ) {
    const prisma = await getPrismaClient();
    const existing = await prisma.tailscaleServeOperation.findUnique({
      where: { requestId },
      include: operationInclude,
    });
    if (existing) return existing;
    const id = randomUUID();
    try {
      return await prisma.tailscaleServeOperation.create({
        data: {
          id,
          kind,
          requestId,
          templateId: templateId ?? null,
          agents: {
            create: [...new Set(agentIds)].map((agentId) => ({ agentId })),
          },
        },
        include: operationInclude,
      });
    } catch (error) {
      const concurrent = await this.operationForRequest(requestId);
      if (concurrent) return concurrent;
      throw error;
    }
  }

  private async persistDispatchState(
    operation: { id: string; templateId: string | null },
    agentId: string,
    payload: unknown,
    state: { status: string; error: string | null; jobId?: string },
  ) {
    const prisma = await getPrismaClient();
    const revision = mutationRevision(payload);
    await prisma.$transaction(async (transaction) => {
      await transaction.tailscaleServeOperationAgent.update({
        where: {
          operationId_agentId: { operationId: operation.id, agentId },
        },
        data: {
          status: state.status,
          error: state.error,
          ...(state.jobId ? { jobId: state.jobId } : {}),
        },
      });
      if (operation.templateId) {
        await transaction.tailscaleServeAssignment.updateMany({
          where: {
            templateId: operation.templateId,
            agentId,
            ...(revision ? { revision } : {}),
          },
          data: {
            status: state.status,
            lastError: state.error,
            ...(state.jobId ? { lastJobId: state.jobId } : {}),
          },
        });
      }
    });
  }

  private async queue(
    operation: Awaited<ReturnType<TailscaleServeService["createOperation"]>>,
    kind: string | ((agentId: string) => string),
    payloadForAgent: (agentId: string, kind: string) => unknown,
  ) {
    for (const item of operation.agents) {
      const agentKind = typeof kind === "string" ? kind : kind(item.agentId);
      let payload: unknown;
      try {
        payload = payloadForAgent(item.agentId, agentKind);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.persistDispatchState(operation, item.agentId, null, {
          status: "FAILED",
          error: message,
        });
        continue;
      }
      const supported = capabilities(item.agent.capabilitiesJson).includes(
        agentKind,
      );
      if (!supported) {
        const message = "This agent does not advertise Tailscale Serve support";
        await this.persistDispatchState(operation, item.agentId, payload, {
          status: "UNSUPPORTED",
          error: message,
        });
        continue;
      }
      try {
        const job = await this.agentControl.createJob({
          agentId: item.agentId,
          kind: agentKind,
          payload,
          idempotencyKey: `${operation.id}:${item.agentId}`,
          timeoutSeconds: 90,
        });
        await this.persistDispatchState(operation, item.agentId, payload, {
          status: job.status,
          error: job.error,
          jobId: job.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.persistDispatchState(operation, item.agentId, payload, {
          status: "FAILED",
          error: message,
        });
      }
    }
    await this.finishOperation(operation.id);
    this.publish(operation.id);
    return (await this.operation(operation.id))!;
  }

  async inspect(agentIds: string[], requestId: string) {
    const retried = await this.operationForRequest(requestId);
    if (retried) return retried;
    const prisma = await getPrismaClient();
    const ids = agentIds.length
      ? [...new Set(agentIds)]
      : (await prisma.agent.findMany({ select: { id: true } })).map(
          ({ id }) => id,
        );
    const operation = await this.createOperation("INSPECT", requestId, ids);
    if (operation.status !== "QUEUING") return operation;
    return this.queue(operation, TAILSCALE_SERVE_INSPECT_JOB_KIND, () => ({
      operationId: operation.id,
    }));
  }

  private async assertNoConflicts(
    templateId: string,
    route: TailscaleServeRoute,
    assignments: Array<{ agentId: string; enabled: boolean }>,
  ) {
    const agentIds = assignments
      .filter(({ enabled }) => enabled)
      .map(({ agentId }) => agentId);
    if (!agentIds.length) return;
    const prisma = await getPrismaClient();
    const active = await prisma.tailscaleServeAssignment.findMany({
      where: {
        agentId: { in: agentIds },
        desiredEnabled: true,
        templateId: { not: templateId },
        template: { lifecycle: { not: "DELETING" } },
      },
      include: { template: true },
    });
    for (const assignment of active) {
      const existing = routeFromTemplate(assignment.template);
      if (tailscaleRoutesConflict(existing, route)) {
        throw new Error(
          `Agent ${assignment.agentId} already has a conflicting listener on port ${route.listenPort}`,
        );
      }
    }
  }

  async upsert(input: TailscaleTemplateInput, requestId: string) {
    const retried = await this.operationForRequest(requestId);
    if (retried) return retried;
    if (!input.assignments.length) {
      throw new Error("At least one explicit agent assignment is required");
    }
    const duplicateAgent = input.assignments.find(
      ({ agentId }, index) =>
        input.assignments.findIndex((item) => item.agentId === agentId) !==
        index,
    );
    if (duplicateAgent) throw new Error("Agent assignments must be unique");
    const prisma = await getPrismaClient();
    const id = input.id ?? randomUUID();
    const existing = input.id
      ? await prisma.tailscaleServeTemplate.findUnique({
          where: { id: input.id },
          include: { assignments: true },
        })
      : null;
    if (input.id && !existing)
      throw new Error("Tailscale Serve template not found");
    if (
      existing &&
      (input.expectedRevision === null ||
        input.expectedRevision === undefined ||
        input.expectedRevision !== existing.revision)
    ) {
      throw new Error(
        "Tailscale Serve template changed; refresh before editing it",
      );
    }
    const route = routeFromInput(input);
    const previouslyEnabled = new Set(
      existing?.assignments
        .filter(({ desiredEnabled }) => desiredEnabled)
        .map(({ agentId }) => agentId) ?? [],
    );
    const prospectiveAssignments = new Map(
      existing?.assignments.map(({ agentId, desiredEnabled }) => [
        agentId,
        desiredEnabled,
      ]) ?? [],
    );
    for (const assignment of input.assignments) {
      prospectiveAssignments.set(assignment.agentId, assignment.enabled);
    }
    const allAssignments = [...prospectiveAssignments].map(
      ([agentId, enabled]) => ({ agentId, enabled }),
    );
    await this.assertNoConflicts(id, route, allAssignments);
    const revision = existing ? existing.revision + 1 : 1;
    const previousRoute = existing ? routeFromTemplate(existing) : null;
    const removeAgentIds = new Set(
      allAssignments
        .filter(
          ({ agentId, enabled }) => !enabled && previouslyEnabled.has(agentId),
        )
        .map(({ agentId }) => agentId),
    );
    const targetAgentIds = [
      ...allAssignments
        .filter(({ enabled }) => enabled)
        .map(({ agentId }) => agentId),
      ...removeAgentIds,
    ];
    const data = {
      ...routeData(route),
      name: validName(input.name),
      revision,
      lifecycle: "ACTIVE",
    };
    const operationId = randomUUID();
    let operation: Awaited<
      ReturnType<TailscaleServeService["createOperation"]>
    >;
    try {
      operation = await prisma.$transaction(async (transaction) => {
        if (existing) {
          const updated = await transaction.tailscaleServeTemplate.updateMany({
            where: { id, revision: input.expectedRevision! },
            data,
          });
          if (updated.count !== 1) {
            throw new Error(
              "Tailscale Serve template changed; refresh before editing it",
            );
          }
        } else {
          await transaction.tailscaleServeTemplate.create({
            data: { id, ...data, origin: "USER" },
          });
        }
        for (const assignment of input.assignments) {
          const participates =
            assignment.enabled || previouslyEnabled.has(assignment.agentId);
          await transaction.tailscaleServeAssignment.upsert({
            where: {
              templateId_agentId: {
                templateId: id,
                agentId: assignment.agentId,
              },
            },
            create: {
              templateId: id,
              agentId: assignment.agentId,
              desiredEnabled: assignment.enabled,
              revision,
              status: participates ? "QUEUING" : "DISABLED",
            },
            update: {
              desiredEnabled: assignment.enabled,
              ...(participates ? { revision } : {}),
              status: participates ? "QUEUING" : "DISABLED",
              lastError: null,
            },
          });
        }
        await transaction.tailscaleServeAssignment.updateMany({
          where: { templateId: id, desiredEnabled: true },
          data: { revision, status: "QUEUING", lastError: null },
        });
        return transaction.tailscaleServeOperation.create({
          data: {
            id: operationId,
            kind: existing ? "UPDATE_TEMPLATE" : "CREATE_TEMPLATE",
            requestId,
            templateId: id,
            agents: {
              create: [...new Set(targetAgentIds)].map((agentId) => ({
                agentId,
              })),
            },
          },
          include: operationInclude,
        });
      });
    } catch (error) {
      const concurrent = await this.operationForRequest(requestId);
      if (concurrent) return concurrent;
      if (String(error).includes("fingerprint")) {
        throw new Error("An identical Tailscale Serve template already exists");
      }
      throw error;
    }
    if (!targetAgentIds.length) {
      await this.finishOperation(operation.id);
      this.publish(operation.id);
      return (await this.operation(operation.id))!;
    }
    return this.queue(
      operation,
      (agentId) =>
        removeAgentIds.has(agentId)
          ? TAILSCALE_SERVE_REMOVE_JOB_KIND
          : TAILSCALE_SERVE_UPSERT_JOB_KIND,
      (_agentId, kind) => ({
        operationId: operation.id,
        templateId: id,
        revision,
        route:
          kind === TAILSCALE_SERVE_REMOVE_JOB_KIND
            ? (previousRoute ?? route)
            : route,
        ...(kind === TAILSCALE_SERVE_UPSERT_JOB_KIND ? { previousRoute } : {}),
      }),
    );
  }

  async setAgentEnabled(
    templateId: string,
    agentId: string,
    enabled: boolean,
    expectedRevision: number,
    requestId: string,
  ) {
    const retried = await this.operationForRequest(requestId);
    if (retried) return retried;
    const prisma = await getPrismaClient();
    const template = await prisma.tailscaleServeTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template || template.lifecycle === "DELETING") {
      throw new Error("Tailscale Serve template not found");
    }
    if (template.revision !== expectedRevision) {
      throw new Error(
        "Tailscale Serve template changed; refresh before updating it",
      );
    }
    const route = routeFromTemplate(template);
    if (enabled)
      await this.assertNoConflicts(templateId, route, [{ agentId, enabled }]);
    await prisma.tailscaleServeAssignment.upsert({
      where: { templateId_agentId: { templateId, agentId } },
      create: {
        templateId,
        agentId,
        desiredEnabled: enabled,
        revision: template.revision,
        status: "QUEUING",
      },
      update: {
        desiredEnabled: enabled,
        revision: template.revision,
        status: "QUEUING",
        lastError: null,
      },
    });
    const operation = await this.createOperation(
      enabled ? "ENABLE_AGENT" : "DISABLE_AGENT",
      requestId,
      [agentId],
      templateId,
    );
    return this.queue(
      operation,
      enabled
        ? TAILSCALE_SERVE_UPSERT_JOB_KIND
        : TAILSCALE_SERVE_REMOVE_JOB_KIND,
      () => ({
        operationId: operation.id,
        templateId,
        revision: template.revision,
        route,
        ...(enabled ? { previousRoute: null } : {}),
      }),
    );
  }

  async delete(
    templateId: string,
    expectedRevision: number,
    requestId: string,
  ) {
    const retried = await this.operationForRequest(requestId);
    if (retried) return retried;
    const prisma = await getPrismaClient();
    const template = await prisma.tailscaleServeTemplate.findUnique({
      where: { id: templateId },
      include: { assignments: true },
    });
    if (!template) throw new Error("Tailscale Serve template not found");
    if (template.revision !== expectedRevision) {
      throw new Error(
        "Tailscale Serve template changed; refresh before deleting it",
      );
    }
    await prisma.tailscaleServeTemplate.update({
      where: { id: templateId },
      data: { lifecycle: "DELETING" },
    });
    const targets = template.assignments.filter(
      (assignment) => assignment.desiredEnabled || assignment.observedEnabled,
    );
    await prisma.tailscaleServeAssignment.updateMany({
      where: { templateId },
      data: { desiredEnabled: false, status: "QUEUING" },
    });
    const operation = await this.createOperation(
      "DELETE_TEMPLATE",
      requestId,
      targets.map(({ agentId }) => agentId),
      templateId,
    );
    if (!targets.length) {
      await prisma.tailscaleServeTemplate.delete({ where: { id: templateId } });
      await this.finishOperation(operation.id);
      this.publish(operation.id);
      return (await this.operation(operation.id))!;
    }
    const route = routeFromTemplate(template);
    return this.queue(operation, TAILSCALE_SERVE_REMOVE_JOB_KIND, () => ({
      operationId: operation.id,
      templateId,
      revision: template.revision,
      route,
    }));
  }

  private async projectSnapshot(
    transaction: Prisma.TransactionClient,
    agentId: string,
    snapshot: TailscaleServeSnapshot,
  ) {
    const inspectedAt = new Date(snapshot.inspectedAt);
    const current = await transaction.tailscaleAgentState.findUnique({
      where: { agentId },
      select: { lastInspectedAt: true },
    });
    if (
      current?.lastInspectedAt &&
      current.lastInspectedAt.getTime() > inspectedAt.getTime()
    ) {
      return;
    }
    await transaction.tailscaleAgentState.upsert({
      where: { agentId },
      create: {
        agentId,
        dnsHostname: snapshot.identity.dnsHostname,
        ipv4Json: JSON.stringify(snapshot.identity.ipv4),
        ipv6Json: JSON.stringify(snapshot.identity.ipv6),
        backendState: snapshot.identity.backendState,
        routesJson: JSON.stringify(snapshot.routes),
        lastInspectedAt: inspectedAt,
      },
      update: {
        dnsHostname: snapshot.identity.dnsHostname,
        ipv4Json: JSON.stringify(snapshot.identity.ipv4),
        ipv6Json: JSON.stringify(snapshot.identity.ipv6),
        backendState: snapshot.identity.backendState,
        routesJson: JSON.stringify(snapshot.routes),
        lastInspectedAt: inspectedAt,
        lastError: null,
      },
    });
    await transaction.tailscaleServeAssignment.updateMany({
      where: { agentId },
      data: {
        observedEnabled: false,
        observedFingerprint: null,
        lastObservedAt: inspectedAt,
      },
    });

    for (const route of snapshot.routes) {
      const fingerprint = tailscaleServeFingerprint(route);
      const listener = tailscaleListenerKey(route);
      const assigned = await transaction.tailscaleServeAssignment.findMany({
        where: { agentId },
        include: { template: true },
      });
      const listenerAssignment = assigned.find(
        (item) =>
          tailscaleListenerKey(routeFromTemplate(item.template)) === listener,
      );
      let templateId: string;
      if (listenerAssignment) {
        templateId = listenerAssignment.templateId;
      } else {
        const exact = await transaction.tailscaleServeTemplate.findUnique({
          where: { fingerprint },
        });
        if (exact) {
          templateId = exact.id;
        } else {
          templateId = randomUUID();
          await transaction.tailscaleServeTemplate.create({
            data: {
              id: templateId,
              name: `Imported ${route.protocol} ${route.listenPort}${route.mountPath === "/" ? "" : route.mountPath}`,
              ...routeData(route),
              origin: "IMPORTED",
            },
          });
        }
      }
      await transaction.tailscaleServeAssignment.upsert({
        where: { templateId_agentId: { templateId, agentId } },
        create: {
          templateId,
          agentId,
          desiredEnabled: true,
          observedEnabled: true,
          observedFingerprint: fingerprint,
          status: "SUCCEEDED",
          lastObservedAt: inspectedAt,
        },
        update: {
          observedEnabled: true,
          observedFingerprint: fingerprint,
          lastObservedAt: inspectedAt,
        },
      });
    }
  }

  private async projectCompletion(job: {
    id: string;
    agentId: string;
    kind: string;
    payloadJson: string;
    status: string;
    resultJson: string | null;
    error: string | null;
  }) {
    let payload: {
      operationId?: string;
      templateId?: string;
      revision?: number;
    } = {};
    try {
      payload = JSON.parse(job.payloadJson) as typeof payload;
    } catch {
      return;
    }
    if (!payload.operationId) return;
    const prisma = await getPrismaClient();
    let finalStatus = operationStatusFromJob(job.status);
    let error = job.error;
    try {
      await prisma.$transaction(async (transaction) => {
        if (job.status === "SUCCEEDED") {
          const result = parseTailscaleServeJobResult(job.resultJson);
          await this.projectSnapshot(transaction, job.agentId, result.snapshot);
        } else {
          await transaction.tailscaleAgentState.upsert({
            where: { agentId: job.agentId },
            create: {
              agentId: job.agentId,
              lastError: error ?? "Tailscale operation failed",
            },
            update: { lastError: error ?? "Tailscale operation failed" },
          });
        }
        if (payload.templateId) {
          const assignment =
            await transaction.tailscaleServeAssignment.findUnique({
              where: {
                templateId_agentId: {
                  templateId: payload.templateId,
                  agentId: job.agentId,
                },
              },
            });
          if (
            assignment &&
            (!payload.revision || assignment.revision === payload.revision)
          ) {
            await transaction.tailscaleServeAssignment.update({
              where: {
                templateId_agentId: {
                  templateId: payload.templateId,
                  agentId: job.agentId,
                },
              },
              data: {
                lastJobId: job.id,
                status: finalStatus,
                lastError:
                  job.status === "SUCCEEDED"
                    ? null
                    : (error ?? "Operation failed"),
              },
            });
          }
        }
        await transaction.tailscaleServeOperationAgent.updateMany({
          where: {
            operationId: payload.operationId,
            agentId: job.agentId,
            jobId: job.id,
          },
          data: {
            status: finalStatus,
            error: job.status === "SUCCEEDED" ? null : error,
          },
        });
      });
    } catch (projectionError) {
      finalStatus = "FAILED";
      error =
        projectionError instanceof Error
          ? projectionError.message
          : String(projectionError);
      await prisma.tailscaleServeOperationAgent.updateMany({
        where: { operationId: payload.operationId, agentId: job.agentId },
        data: { status: finalStatus, error },
      });
    }
    await this.finishOperation(payload.operationId);
    this.publish(payload.operationId);
  }

  private async finishOperation(operationId: string) {
    const prisma = await getPrismaClient();
    const operation = await prisma.tailscaleServeOperation.findUnique({
      where: { id: operationId },
      include: { agents: true },
    });
    if (!operation) return;
    const allFinished = operation.agents.every((item) =>
      TERMINAL_OPERATION_ITEM_STATUSES.has(item.status),
    );
    if (!allFinished) {
      await prisma.tailscaleServeOperation.update({
        where: { id: operationId },
        data: {
          status: operation.agents.some((item) => item.status === "RUNNING")
            ? "RUNNING"
            : "QUEUED",
        },
      });
      return;
    }
    const failures = operation.agents.filter(
      (item) => item.status !== "SUCCEEDED",
    );
    const status = failures.length
      ? failures.length === operation.agents.length
        ? "FAILED"
        : "PARTIAL_FAILED"
      : "SUCCEEDED";
    await prisma.tailscaleServeOperation.update({
      where: { id: operationId },
      data: { status, finishedAt: new Date() },
    });
    if (
      operation.kind === "DELETE_TEMPLATE" &&
      status === "SUCCEEDED" &&
      operation.templateId
    ) {
      await prisma.tailscaleServeTemplate.deleteMany({
        where: { id: operation.templateId },
      });
    }
  }
}
