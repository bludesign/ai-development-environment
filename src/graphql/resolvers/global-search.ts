import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { GlobalSearchService } from "@/services/global-search";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createGlobalSearchResolvers = (service: GlobalSearchService) => ({
  Query: {
    globalSearch: (
      _root: unknown,
      {
        query,
        firstPerGroup,
        relatedFirst,
      }: {
        query: string;
        firstPerGroup?: number | null;
        relatedFirst?: number | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.search(query, firstPerGroup ?? 5, relatedFirst ?? 3);
    },
  },
});
