import {
  SIMULATOR_ACTION_JOB_KIND,
  SIMULATOR_CREATE_JOB_KIND,
  SIMULATOR_INSPECT_JOB_KIND,
  SIMULATOR_INVENTORY_JOB_KIND,
  SIMULATOR_RESET_JOB_KIND,
  parseSimulatorDetails,
  parseSimulatorInventory,
  simulatorActionPayload,
  simulatorCreatePayload,
  simulatorInspectPayload,
  simulatorInventoryPayload,
  type SimulatorAction,
  type SimulatorPlatform,
} from "@ai-development-environment/agent-contract/simulators";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { SimulatorsService } from "@/services/simulators/simulators.service";

type SimulatorRequest = {
  agentId: string;
  requestId: string;
  platform?: SimulatorPlatform | null;
};
type CompletedJob = { kind: string; status: string; resultJson: string | null };

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId)
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
}

function result<T>(
  job: CompletedJob,
  kind: string,
  key: string,
  parse: (value: unknown) => T,
): T | null {
  if (job.kind !== kind || job.status !== "SUCCEEDED" || !job.resultJson)
    return null;
  try {
    const parsed = JSON.parse(job.resultJson) as Record<string, unknown>;
    return parse(parsed[key]);
  } catch {
    return null;
  }
}

export function createSimulatorResolvers(service: SimulatorsService) {
  return {
    AgentJob: {
      simulatorInventory: (job: CompletedJob) =>
        result(
          job,
          SIMULATOR_INVENTORY_JOB_KIND,
          "inventory",
          parseSimulatorInventory,
        ),
      simulatorDetails: (job: CompletedJob) =>
        result(
          job,
          SIMULATOR_INSPECT_JOB_KIND,
          "details",
          parseSimulatorDetails,
        ),
    },
    Mutation: {
      refreshSimulatorInventory(
        _root: unknown,
        { agentId, requestId, platform }: SimulatorRequest,
        context: GraphQLContext,
      ) {
        requireControlPlane(context);
        return service.enqueue(
          agentId,
          requestId,
          SIMULATOR_INVENTORY_JOB_KIND,
          simulatorInventoryPayload({ platform }),
        );
      },
      inspectSimulator(
        _root: unknown,
        {
          agentId,
          requestId,
          simulatorId,
          platform,
        }: SimulatorRequest & { simulatorId: string },
        context: GraphQLContext,
      ) {
        requireControlPlane(context);
        return service.enqueue(
          agentId,
          requestId,
          SIMULATOR_INSPECT_JOB_KIND,
          simulatorInspectPayload({ simulatorId, platform }),
        );
      },
      createSimulator(
        _root: unknown,
        {
          input: { agentId, requestId, ...payload },
        }: {
          input: SimulatorRequest & {
            name: string;
            runtimeId: string;
            deviceTypeId: string;
          };
        },
        context: GraphQLContext,
      ) {
        requireControlPlane(context);
        return service.enqueue(
          agentId,
          requestId,
          SIMULATOR_CREATE_JOB_KIND,
          simulatorCreatePayload(payload),
        );
      },
      resetSimulators(
        _root: unknown,
        { agentId, requestId }: SimulatorRequest,
        context: GraphQLContext,
      ) {
        requireControlPlane(context);
        return service.enqueue(
          agentId,
          requestId,
          SIMULATOR_RESET_JOB_KIND,
          {},
        );
      },
      performSimulatorAction(
        _root: unknown,
        {
          input: {
            agentId,
            requestId,
            simulatorId,
            action,
            name,
            bundleId,
            platform,
          },
        }: {
          input: SimulatorRequest & {
            simulatorId: string;
            action: SimulatorAction;
            name?: string | null;
            bundleId?: string | null;
          };
        },
        context: GraphQLContext,
      ) {
        requireControlPlane(context);
        return service.enqueue(
          agentId,
          requestId,
          SIMULATOR_ACTION_JOB_KIND,
          simulatorActionPayload({
            simulatorId,
            platform,
            action,
            ...(name == null ? {} : { name }),
            ...(bundleId == null ? {} : { bundleId }),
          }),
        );
      },
    },
  };
}
