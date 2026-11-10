import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  StartWorktreeMergeBatchInput,
  WorktreeMergeService,
} from "@/services/worktrees/worktree-merge.service";

function requireControlPlane(context: GraphQLContext) {
  if (context.agentId)
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
}

type Scope = { appId?: string | null; agentId?: string | null };

export const createWorktreeMergeResolvers = (
  service: WorktreeMergeService,
) => ({
  Query: {
    worktreeMergeCandidates: (
      _: unknown,
      scope: Scope,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.candidates(scope);
    },
    worktreeMergeBatches: (
      _: unknown,
      scope: Scope,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.batches(scope);
    },
    worktreeMergeBatch: (
      _: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.batch(id);
    },
  },
  Mutation: {
    startWorktreeMergeBatch: (
      _: unknown,
      { input }: { input: StartWorktreeMergeBatchInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.start(input);
    },
  },
});
