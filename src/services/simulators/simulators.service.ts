import { createHash } from "node:crypto";

import {
  ANDROID_SIMULATORS_CAPABILITY,
  SIMULATOR_ACTION_JOB_KIND,
  SIMULATOR_CREATE_JOB_KIND,
  SIMULATOR_INSPECT_JOB_KIND,
  SIMULATOR_INVENTORY_JOB_KIND,
  SIMULATOR_JOB_KINDS,
  SIMULATOR_RESET_JOB_KIND,
  parseSimulatorDetails,
  parseSimulatorInventory,
  simulatorActionPayload,
  simulatorCreatePayload,
  simulatorEmptyPayload,
  simulatorId,
  simulatorInspectPayload,
  simulatorInventoryPayload,
  simulatorPlatform,
  type SimulatorAction,
  type SimulatorDetails,
  type SimulatorInventory,
  type SimulatorJobKind,
} from "@ai-development-environment/agent-contract/simulators";
import { getPrismaClient } from "@/data/prisma-client";
import {
  agentOnlineWindowMs,
  type AgentControlService,
} from "@/services/agent-control";

const simulatorPayloads = {
  [SIMULATOR_ACTION_JOB_KIND]: simulatorActionPayload,
  [SIMULATOR_CREATE_JOB_KIND]: simulatorCreatePayload,
  [SIMULATOR_INSPECT_JOB_KIND]: simulatorInspectPayload,
  [SIMULATOR_INVENTORY_JOB_KIND]: simulatorInventoryPayload,
  [SIMULATOR_RESET_JOB_KIND]: simulatorEmptyPayload,
};

const AUTOMATION_KEY_PREFIX = "simulator-automation:";
const WORKFLOW_KEY_PREFIX = `${AUTOMATION_KEY_PREFIX}workflow:`;

export const MAX_SIMULATOR_DELETE_TARGETS = 200;

export type SimulatorAutomation = {
  source: "MCP" | "WORKFLOW";
  requestScope?: readonly string[];
};
type SimulatorTarget = {
  agentId: string;
  simulatorId: string;
  platform?: "APPLE" | "ANDROID";
};
type SimulatorDeleteOutcome = SimulatorTarget & {
  jobId: string | null;
  status: string | null;
  error: string | null;
};
type SimulatorJob = {
  id: string;
  agentId: string;
  kind: string;
  payloadJson: string;
  resultJson: string | null;
  status: string;
  error: string | null;
  timeoutSeconds: number;
};

export type SimulatorOperation =
  SimulatorAction | "INVENTORY" | "INSPECT" | "CREATE" | "RESET";

export function isWorkflowSimulatorJob(job: { idempotencyKey: string }) {
  return job.idempotencyKey.startsWith(WORKFLOW_KEY_PREFIX);
}

function isSimulatorJobKind(kind: string): kind is SimulatorJobKind {
  return SIMULATOR_JOB_KINDS.some((candidate) => candidate === kind);
}

export function summarizeSimulatorJob(job: SimulatorJob) {
  if (!isSimulatorJobKind(job.kind)) throw new Error("Simulator job not found");
  let operation: SimulatorOperation;
  let deviceId: string | null = null;
  let bundleId: string | null = null;
  const payloadPlatform = simulatorPlatform(
    JSON.parse(job.payloadJson).platform,
  );
  switch (job.kind) {
    case SIMULATOR_ACTION_JOB_KIND: {
      const payload = simulatorActionPayload(JSON.parse(job.payloadJson));
      operation = payload.action;
      deviceId = payload.simulatorId;
      bundleId = "bundleId" in payload ? payload.bundleId : null;
      break;
    }
    case SIMULATOR_INSPECT_JOB_KIND:
      operation = "INSPECT";
      deviceId = simulatorInspectPayload(
        JSON.parse(job.payloadJson),
      ).simulatorId;
      break;
    case SIMULATOR_CREATE_JOB_KIND:
      operation = "CREATE";
      break;
    case SIMULATOR_INVENTORY_JOB_KIND:
      operation = "INVENTORY";
      break;
    case SIMULATOR_RESET_JOB_KIND:
      operation = "RESET";
      break;
  }

  let inventory: SimulatorInventory | null = null;
  let details: SimulatorDetails | null = null;
  let error = job.error;
  if (job.status === "SUCCEEDED") {
    try {
      if (operation === "INVENTORY") {
        inventory = parseSimulatorInventory(
          JSON.parse(job.resultJson ?? "{}").inventory,
        );
      } else if (operation === "INSPECT") {
        details = parseSimulatorDetails(
          JSON.parse(job.resultJson ?? "{}").details,
        );
        if (details.simulator.id !== deviceId) {
          details = null;
          throw new Error("Simulator details returned a different identifier");
        }
      } else if (
        operation === "CREATE" ||
        operation === "CLONE" ||
        (operation === "RENAME" && payloadPlatform === "ANDROID")
      ) {
        deviceId = simulatorId(JSON.parse(job.resultJson ?? "{}").simulatorId);
      }
    } catch (failure) {
      error = `Invalid simulator job result: ${errorMessage(failure)}`;
    }
  }

  return {
    jobId: job.id,
    agentId: job.agentId,
    operation,
    ...(payloadPlatform === "ANDROID" ? { platform: payloadPlatform } : {}),
    status: job.status,
    error,
    timeoutSeconds: job.timeoutSeconds,
    simulatorId: deviceId,
    bundleId,
    inventory,
    details,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function checkedRequestId(requestId: string) {
  const request = requestId.trim();
  if (!request || request.length > 200 || request.includes("\0"))
    throw new Error("Simulator request ID is invalid");
  return request;
}

function checkedAgentId(agentId: string) {
  if (typeof agentId !== "string" || !agentId.trim() || agentId.includes("\0"))
    throw new Error("Simulator agent ID is invalid");
  return agentId;
}

async function reserveAutomationRequest(
  requestId: string,
  automation: SimulatorAutomation,
  payload: unknown,
) {
  const requestDigest = digest(
    automation.requestScope ? [automation.requestScope, requestId] : requestId,
  );
  const requestKey = `${AUTOMATION_KEY_PREFIX}${automation.source.toLowerCase()}:${requestDigest}`;
  const payloadDigest = digest(payload);
  const prisma = await getPrismaClient();
  // Reserve the full request before dispatch. A retry can recover jobs already
  // submitted or enqueue missing targets after a partial submission.
  const receipt = await prisma.simulatorRequestReceipt.upsert({
    where: { requestKey },
    create: { requestKey, payloadDigest },
    update: { requestKey },
  });
  if (receipt.payloadDigest !== payloadDigest)
    throw new Error(
      "Simulator request ID was already used with a different payload",
    );
  return requestKey;
}

export class SimulatorsService {
  constructor(private readonly agentControl: AgentControlService) {}

  async enqueue(
    agentId: string,
    requestId: string,
    kind: SimulatorJobKind,
    payload: unknown,
    automation?: SimulatorAutomation,
  ) {
    checkedAgentId(agentId);
    const request = checkedRequestId(requestId);
    const normalized = simulatorPayloads[kind](payload);
    const idempotencyKey = automation
      ? await reserveAutomationRequest(request, automation, [
          agentId,
          kind,
          normalized,
        ])
      : `${kind}:${request}`;
    return this.enqueueJob(agentId, kind, normalized, idempotencyKey);
  }

  async getJob(agentId: string, jobId: string) {
    const job = await this.agentControl.getJob(jobId);
    if (!job || job.agentId !== agentId)
      throw new Error("Simulator job not found");
    return summarizeSimulatorJob(job);
  }

  async getJobs(targets: { agentId: string; jobId: string }[]) {
    const jobs = await this.agentControl.getJobs(
      targets.map(({ jobId }) => jobId),
    );
    const byId = new Map(jobs.map((job) => [job.id, job]));
    return targets.flatMap(({ agentId, jobId }) => {
      const job = byId.get(jobId);
      return job?.agentId === agentId && isSimulatorJobKind(job.kind)
        ? [summarizeSimulatorJob(job)]
        : [];
    });
  }

  async deleteSelected(
    targets: SimulatorTarget[],
    requestId: string,
    automation: SimulatorAutomation,
    shouldStopSubmitting?: () => boolean,
  ): Promise<{ targets: SimulatorDeleteOutcome[] }> {
    if (
      !Array.isArray(targets) ||
      !targets.length ||
      targets.length > MAX_SIMULATOR_DELETE_TARGETS
    )
      throw new Error(
        `Select between 1 and ${MAX_SIMULATOR_DELETE_TARGETS} simulators`,
      );
    const byTarget = new Map<string, SimulatorTarget>();
    for (const target of targets) {
      if (!target || typeof target !== "object")
        throw new Error(
          "Simulator deletion targets require an agent ID and simulator identifier",
        );
      const normalized = {
        agentId: checkedAgentId(target.agentId),
        simulatorId: simulatorInspectPayload(
          target.platform
            ? { simulatorId: target.simulatorId, platform: target.platform }
            : { simulatorId: target.simulatorId },
        ).simulatorId,
      };
      byTarget.set(
        JSON.stringify([normalized.agentId, normalized.simulatorId]),
        normalized,
      );
    }
    const batchKey = await reserveAutomationRequest(
      checkedRequestId(requestId),
      automation,
      ["delete-selected", [...byTarget.keys()].sort()],
    );
    const outcomes: SimulatorDeleteOutcome[] = [];
    for (const [key, target] of byTarget) {
      if (shouldStopSubmitting?.()) break;
      try {
        const job = await this.enqueueJob(
          target.agentId,
          SIMULATOR_ACTION_JOB_KIND,
          simulatorActionPayload({
            simulatorId: target.simulatorId,
            action: "DELETE",
          }),
          `${batchKey}:${digest(key)}`,
        );
        outcomes.push({
          ...target,
          jobId: job.id,
          status: job.status,
          error: job.error,
        });
      } catch (error) {
        outcomes.push({
          ...target,
          jobId: null,
          status: null,
          error: errorMessage(error),
        });
      }
    }
    return { targets: outcomes };
  }

  private async enqueueJob(
    agentId: string,
    kind: SimulatorJobKind,
    payload: unknown,
    idempotencyKey: string,
  ) {
    const assertSamePayload = (job: SimulatorJob) => {
      if (
        job.kind !== kind ||
        digest(simulatorPayloads[kind](JSON.parse(job.payloadJson))) !==
          digest(payload)
      )
        throw new Error(
          "Simulator request ID was already used with a different payload",
        );
    };
    const existing = await this.agentControl.getJobByIdempotencyKey(
      agentId,
      idempotencyKey,
    );
    if (existing) {
      assertSamePayload(existing);
      return existing;
    }
    const agent = await this.agentControl.getAgent(agentId);
    if (!agent) throw new Error("Agent not found");
    if (
      !agent.lastSeenAt ||
      agent.disconnectedAt ||
      Date.now() - agent.lastSeenAt.getTime() > agentOnlineWindowMs(agent)
    ) {
      throw new Error(`${agent.name} is offline`);
    }
    let capabilities: unknown;
    try {
      capabilities = JSON.parse(agent.capabilitiesJson);
    } catch {
      capabilities = null;
    }
    const platform = simulatorPlatform(
      (payload as { platform?: unknown }).platform,
    );
    if (
      !Array.isArray(capabilities) ||
      !capabilities.includes(kind) ||
      (platform === "ANDROID" &&
        !capabilities.includes(ANDROID_SIMULATORS_CAPABILITY))
    )
      throw new Error(
        `${agent.name} does not support this simulator operation`,
      );

    const job = await this.agentControl.createJob({
      agentId,
      kind,
      payload,
      idempotencyKey,
      timeoutSeconds:
        kind === SIMULATOR_RESET_JOB_KIND
          ? 600
          : platform === "ANDROID"
            ? 300
            : 120,
      visibility:
        kind === SIMULATOR_INVENTORY_JOB_KIND ||
        kind === SIMULATOR_INSPECT_JOB_KIND
          ? "SYSTEM"
          : "USER",
    });
    assertSamePayload(job);
    return job;
  }
}
