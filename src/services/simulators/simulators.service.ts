import {
  SIMULATOR_INSPECT_JOB_KIND,
  SIMULATOR_INVENTORY_JOB_KIND,
  SIMULATOR_RESET_JOB_KIND,
  type SimulatorJobKind,
} from "@ai-development-environment/agent-contract/simulators";
import {
  agentOnlineWindowMs,
  type AgentControlService,
} from "@/services/agent-control";

export class SimulatorsService {
  constructor(private readonly agentControl: AgentControlService) {}

  async enqueue(
    agentId: string,
    requestId: string,
    kind: SimulatorJobKind,
    payload: unknown,
  ) {
    const request = requestId.trim();
    if (!request || request.length > 200 || request.includes("\0"))
      throw new Error("Simulator request ID is invalid");

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
    if (!Array.isArray(capabilities) || !capabilities.includes(kind))
      throw new Error(
        `${agent.name} does not support this simulator operation`,
      );

    return this.agentControl.createJob({
      agentId,
      kind,
      payload,
      idempotencyKey: `${kind}:${request}`,
      timeoutSeconds: kind === SIMULATOR_RESET_JOB_KIND ? 600 : 120,
      visibility:
        kind === SIMULATOR_INVENTORY_JOB_KIND ||
        kind === SIMULATOR_INSPECT_JOB_KIND
          ? "SYSTEM"
          : "USER",
    });
  }
}
