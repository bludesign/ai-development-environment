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
      { first, after }: { first?: number; after?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.history(first, after);
    },
  },
  Mutation: {
    refreshDerivedData: (
      _root: unknown,
      { requestId }: { requestId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.refresh(requestId);
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
      }: { collectionId: string; entryIds: string[]; requestId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteEntries(collectionId, entryIds, requestId);
    },
    clearDerivedDataDeletionHistory: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.clearHistory();
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
