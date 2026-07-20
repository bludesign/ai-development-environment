import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { SigningAssetsService } from "@/services/signing-assets";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error("Agent credentials cannot perform signing operations");
  }
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

export const createSigningAssetsResolvers = (
  service: SigningAssetsService,
) => ({
  SigningOperation: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
    finishedAt: (value: { finishedAt: Date | null }) => iso(value.finishedAt),
  },
  SigningOperationItem: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    finishedAt: (value: { finishedAt: Date | null }) => iso(value.finishedAt),
  },
  Query: {
    signingAgents: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.agents();
    },
    signingProfiles: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.profiles();
    },
    signingProfile: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.profile(id);
    },
    signingCertificates: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.certificates();
    },
    signingOperations: (
      _root: unknown,
      { limit }: { limit?: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.operations(limit);
    },
    appleDeveloperInventory: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.portalInventory();
    },
  },
  Mutation: {
    refreshSigningAssets: (
      _root: unknown,
      { agentIds }: { agentIds?: string[] | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.refresh(agentIds ?? undefined);
    },
    uploadSigningProfile: (
      _root: unknown,
      args: { contentBase64: string; targetAgentIds: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.uploadProfile(args.contentBase64, args.targetAgentIds);
    },
    downloadSigningProfile: (
      _root: unknown,
      args: { uuid: string; agentId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.downloadProfile(args.uuid, args.agentId);
    },
    syncSigningProfile: (
      _root: unknown,
      args: { uuid: string; sourceAgentId: string; targetAgentIds: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.syncProfile(
        args.uuid,
        args.sourceAgentId,
        args.targetAgentIds,
      );
    },
    deleteSigningProfile: (
      _root: unknown,
      args: { uuid: string; agentIds: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteProfile(args.uuid, args.agentIds);
    },
    deleteExpiredSigningProfiles: (
      _root: unknown,
      { agentIds }: { agentIds?: string[] | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteExpiredProfiles(agentIds ?? undefined);
    },
    importSigningIdentity: (
      _root: unknown,
      args: {
        p12Base64: string;
        passphrase: string;
        targetAgentIds: string[];
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.importIdentity(args);
    },
    deleteSigningIdentity: (
      _root: unknown,
      args: { sha1: string; agentIds: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteIdentity(args.sha1, args.agentIds);
    },
    createApplePortalProfile: (
      _root: unknown,
      {
        input,
      }: { input: Parameters<SigningAssetsService["createPortalProfile"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.createPortalProfile(input);
    },
    deleteApplePortalProfile: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deletePortalProfile(id);
    },
    revokeApplePortalCertificate: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.revokePortalCertificate(id);
    },
  },
  Subscription: {
    signingAssetsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
      resolve: () => true,
    },
  },
});
