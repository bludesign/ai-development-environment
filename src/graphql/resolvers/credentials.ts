import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { CredentialService } from "@/services/credentials";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createCredentialResolvers = (
  credentialService: CredentialService,
) => ({
  CredentialStorageType: {
    DATABASE: "database",
    VAULT: "vault",
    KEYCHAIN: "keychain",
    UNKNOWN: "unknown",
  },
  Query: {
    credentialStoreStatus: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return credentialService.status();
    },
    credentials: (_root: unknown, _args: unknown, context: GraphQLContext) => {
      requireControlPlane(context);
      return credentialService.list();
    },
  },
});
