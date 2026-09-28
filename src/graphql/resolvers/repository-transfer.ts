import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { RepositoryTransferService } from "@/services/repository-transfer/repository-transfer.service";
import type {
  TransferExportInput,
  TransferImportInput,
  TransferDestinationInput,
} from "@/services/repository-transfer/package";
function control(context: GraphQLContext) {
  if (context.agentId)
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
}
export const createRepositoryTransferResolvers = (
  service: RepositoryTransferService,
) => ({
  RepositoryTransferOperation: {
    createdAt: (value: { createdAt: Date | string }) =>
      new Date(value.createdAt).toISOString(),
    updatedAt: (value: { updatedAt: Date | string }) =>
      new Date(value.updatedAt).toISOString(),
    result: (value: { resultJson?: string; result?: unknown }) =>
      value.result ?? JSON.parse(value.resultJson ?? "{}"),
  },
  Query: {
    repositoryTransferExportPreview: (
      _root: unknown,
      { input }: { input: TransferExportInput },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.exportPreview(input);
    },
    exportRepositoryTransfer: (
      _root: unknown,
      { input }: { input: TransferExportInput },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.export(input);
    },
    previewRepositoryTransfer: (
      _root: unknown,
      { input }: { input: TransferImportInput },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.preview(input);
    },
    repositoryTransferOperation: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.clones.get(id);
    },
    appRepositorySync: (
      _root: unknown,
      { appId }: { appId: string },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.syncOverview(appId);
    },
  },
  Mutation: {
    applyRepositoryTransfer: (
      _root: unknown,
      {
        input,
        fingerprint,
        requestId,
      }: { input: TransferImportInput; fingerprint: string; requestId: string },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.apply(input, fingerprint, requestId);
    },
    retryRepositoryTransfer: (
      _root: unknown,
      { id, requestId }: { id: string; requestId: string },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.clones.retry(id, requestId);
    },
    syncAppRepositories: (
      _root: unknown,
      {
        appId,
        destinations,
        fingerprint,
        requestId,
      }: {
        appId: string;
        destinations: TransferDestinationInput[];
        fingerprint: string;
        requestId: string;
      },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.sync(appId, destinations, fingerprint, requestId);
    },
  },
  Subscription: {
    repositoryTransferChanged: {
      resolve: (event: { repositoryTransferChanged: string }) =>
        service.clones.get(event.repositoryTransferChanged),
      subscribe: (
        _root: unknown,
        { operationId }: { operationId: string },
        context: GraphQLContext,
      ) => {
        control(context);
        return service.clones.subscribe(operationId);
      },
    },
  },
});
