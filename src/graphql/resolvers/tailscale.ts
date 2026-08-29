import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  TailscaleServeService,
  TailscaleTemplateInput,
} from "@/services/tailscale";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

export const createTailscaleResolvers = (service: TailscaleServeService) => ({
  TailscaleServeTemplate: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  TailscaleServeAssignment: {
    lastObservedAt: (value: { lastObservedAt: Date | null }) =>
      iso(value.lastObservedAt),
  },
  TailscaleServeOperation: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    finishedAt: (value: { finishedAt: Date | null }) => iso(value.finishedAt),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  Query: {
    tailscaleServeOverview: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.overview();
    },
    tailscaleServeOperation: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.operation(id);
    },
  },
  Mutation: {
    inspectTailscaleServe: (
      _root: unknown,
      { agentIds, requestId }: { agentIds: string[]; requestId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.inspect(agentIds, requestId);
    },
    upsertTailscaleServeTemplate: (
      _root: unknown,
      {
        input,
        requestId,
      }: { input: TailscaleTemplateInput; requestId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.upsert(input, requestId);
    },
    setTailscaleServeAgentEnabled: (
      _root: unknown,
      args: {
        templateId: string;
        agentId: string;
        enabled: boolean;
        expectedRevision: number;
        requestId: string;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.setAgentEnabled(
        args.templateId,
        args.agentId,
        args.enabled,
        args.expectedRevision,
        args.requestId,
      );
    },
    deleteTailscaleServeTemplate: (
      _root: unknown,
      {
        id,
        expectedRevision,
        requestId,
      }: {
        id: string;
        expectedRevision: number;
        requestId: string;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.delete(id, expectedRevision, requestId);
    },
  },
  Subscription: {
    tailscaleServeOverviewChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeOverview();
      },
      resolve: () => service.overview(),
    },
    tailscaleServeOperationChanged: {
      subscribe: (
        _root: unknown,
        { id }: { id: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return service.subscribeOperation(id);
      },
      resolve: (_value: unknown, { id }: { id: string }) =>
        service.operation(id),
    },
  },
});
