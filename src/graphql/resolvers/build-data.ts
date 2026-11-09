import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  BuildDataCollectionSnapshot,
  BuildDataService,
} from "@/services/build-data";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createBuildDataResolvers = (service: BuildDataService) => ({
  DerivedDataDeletionHistory: {
    deletedAt: (value: { deletedAt: Date }) => value.deletedAt.toISOString(),
  },
  Query: {
    derivedDataCollection: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.getCollection(id);
    },
    derivedDataDeletionHistory: (
      _root: unknown,
      {
        first,
        after,
        agentId,
      }: { first?: number; after?: string | null; agentId?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.history(first, after, agentId);
    },
  },
  Mutation: {
    refreshDerivedData: (
      _root: unknown,
      { requestId, agentId }: { requestId: string; agentId?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.refresh(requestId, agentId);
    },
    calculateDerivedDataSizes: (
      _root: unknown,
      {
        collectionId,
        entryIds,
        requestId,
      }: { collectionId: string; entryIds: string[]; requestId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.calculateSizes(collectionId, entryIds, requestId);
    },
    deleteDerivedDataEntries: (
      _root: unknown,
      {
        collectionId,
        entryIds,
        requestId,
        overrideProtection,
      }: {
        collectionId: string;
        entryIds: string[];
        requestId: string;
        overrideProtection?: boolean;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteEntries(
        collectionId,
        entryIds,
        requestId,
        overrideProtection,
      );
    },
    setDerivedDataEntryLocked: (
      _root: unknown,
      {
        collectionId,
        entryId,
        locked,
      }: { collectionId: string; entryId: string; locked: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.setEntryLocked(collectionId, entryId, locked);
    },
    clearDerivedDataDeletionHistory: (
      _root: unknown,
      { agentId }: { agentId?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.clearHistory(agentId);
    },
  },
  Subscription: {
    derivedDataCollectionChanged: {
      subscribe: (
        _root: unknown,
        { id }: { id: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return service.subscribe(id);
      },
      resolve: (snapshot: BuildDataCollectionSnapshot) => snapshot,
    },
  },
});
