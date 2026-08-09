import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  CliHealthService,
  CustomCliHealthCheck,
} from "@/services/cli-health";
import {
  agentEventBus,
  CLI_HEALTH_CHANGED_TOPIC,
} from "@/services/agent-control";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createCliHealthResolvers = (service: CliHealthService) => ({
  Query: {
    installationStatus: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.installationStatus();
    },
    agentCliHealthStatus: (
      _root: unknown,
      { agentId }: { agentId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.statusForAgent(agentId);
    },
  },
  Mutation: {
    runCliHealthChecks: (
      _root: unknown,
      { agentId }: { agentId?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.run(agentId);
    },
    saveCliHealthSettings: (
      _root: unknown,
      { checks }: { checks: Array<Partial<CustomCliHealthCheck>> },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveSettings(checks);
    },
  },
  Subscription: {
    cliHealthStatusChanged: {
      subscribe: (
        _root: unknown,
        { agentId }: { agentId?: string | null },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return agentEventBus.iterate<{
          cliHealthStatusChanged: { agentId: string | null };
        }>(
          CLI_HEALTH_CHANGED_TOPIC,
          agentId
            ? (event) =>
                event.cliHealthStatusChanged.agentId === null ||
                event.cliHealthStatusChanged.agentId === agentId
            : undefined,
        );
      },
    },
  },
});
