import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { SseService } from "@/services/sse";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error("Agent credentials cannot manage SSE endpoints");
  }
}

function origin(value: string | null | undefined, context: GraphQLContext) {
  return value ?? context.requestOrigin;
}

export const createSseResolvers = (service: SseService) => ({
  SseRequestHistory: {
    eventCount: (value: {
      eventCount?: number;
      _count?: { events?: number };
      events?: unknown[];
    }) => value.eventCount ?? value._count?.events ?? value.events?.length ?? 0,
  },
  Query: {
    sseEndpoints: (
      _root: unknown,
      { requestOrigin }: { requestOrigin?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.endpoints(origin(requestOrigin, context));
    },
    sseEndpointPage: (
      _root: unknown,
      {
        first,
        after,
        requestOrigin,
      }: {
        first?: number | null;
        after?: string | null;
        requestOrigin?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.endpointsPage(
        { first, after },
        origin(requestOrigin, context),
      );
    },
    sseEndpoint: (
      _root: unknown,
      { id, requestOrigin }: { id: string; requestOrigin?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service
        .endpoint(id, origin(requestOrigin, context))
        .catch(() => null);
    },
    sseMockEventTemplates: (
      _root: unknown,
      { endpointId }: { endpointId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.eventTemplates(endpointId);
    },
    sseMockEventTemplatePage: (
      _root: unknown,
      {
        endpointId,
        first,
        after,
      }: { endpointId: string; first?: number | null; after?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.eventTemplatesPage(endpointId, { first, after });
    },
    sseMockCompositions: (
      _root: unknown,
      { endpointId }: { endpointId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.compositions(endpointId);
    },
    sseMockCompositionPage: (
      _root: unknown,
      {
        endpointId,
        first,
        after,
      }: { endpointId: string; first?: number | null; after?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.compositionsPage(endpointId, { first, after });
    },
    sseStorageEntries: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.storageEntries();
    },
    sseStorageEntryPage: (
      _root: unknown,
      { first, after }: { first?: number | null; after?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.storageEntriesPage({ first, after });
    },
    sseBreakpoints: (
      _root: unknown,
      { status }: { status?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.breakpoints(status);
    },
    sseBreakpointPage: (
      _root: unknown,
      {
        status,
        first,
        after,
      }: {
        status?: string | null;
        first?: number | null;
        after?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.breakpointsPage(status, { first, after });
    },
    sseHistory: (
      _root: unknown,
      { input }: { input: Parameters<SseService["history"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.history(input);
    },
    sseHistoryRequest: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.historyRequest(id);
    },
    sseHistoryFacets: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.historyFacets();
    },
    sseHistoryFacetPage: (
      _root: unknown,
      { first, after }: { first?: number | null; after?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.historyFacetsPage({ first, after });
    },
    sseHistoryViewSettings: (
      _root: unknown,
      { view }: { view: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.historyViewSettings(view);
    },
    sseHistoryColumnPresets: (
      _root: unknown,
      { view }: { view: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.historyColumnPresets(view);
    },
    sseHistoryColumnPresetPage: (
      _root: unknown,
      {
        view,
        first,
        after,
      }: { view: string; first?: number | null; after?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.historyColumnPresetsPage(view, { first, after });
    },
    sseHistorySavedFilters: (
      _root: unknown,
      { view }: { view: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.historySavedFilters(view);
    },
    sseHistorySavedFilterPage: (
      _root: unknown,
      {
        view,
        first,
        after,
      }: { view: string; first?: number | null; after?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.historySavedFiltersPage(view, { first, after });
    },
  },
  Mutation: {
    createSseEndpoint: (
      _root: unknown,
      {
        input,
        requestOrigin,
      }: {
        input: Parameters<SseService["createEndpoint"]>[0];
        requestOrigin?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.createEndpoint(input, origin(requestOrigin, context));
    },
    updateSseEndpoint: (
      _root: unknown,
      {
        id,
        input,
        requestOrigin,
      }: {
        id: string;
        input: Parameters<SseService["updateEndpoint"]>[1];
        requestOrigin?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.updateEndpoint(id, input, origin(requestOrigin, context));
    },
    deleteSseEndpoint: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteEndpoint(id);
    },
    rotateSseEndpointToken: (
      _root: unknown,
      { id, requestOrigin }: { id: string; requestOrigin?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.rotateToken(id, origin(requestOrigin, context));
    },
    setSseEndpointMode: (
      _root: unknown,
      {
        id,
        mode,
        requestOrigin,
      }: {
        id: string;
        mode: "FORWARD" | "MOCK" | "BREAKPOINT";
        requestOrigin?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.setMode(id, mode, origin(requestOrigin, context));
    },
    saveSseMockEventTemplate: (
      _root: unknown,
      {
        endpointId,
        input,
      }: {
        endpointId: string;
        input: Parameters<SseService["saveEventTemplate"]>[1];
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveEventTemplate(endpointId, input);
    },
    deleteSseMockEventTemplate: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteEventTemplate(id);
    },
    saveSseMockComposition: (
      _root: unknown,
      {
        endpointId,
        id,
        input,
      }: {
        endpointId: string;
        id?: string | null;
        input: Parameters<SseService["saveComposition"]>[1];
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveComposition(endpointId, input, id);
    },
    deleteSseMockComposition: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteComposition(id);
    },
    activateSseMockComposition: (
      _root: unknown,
      {
        endpointId,
        compositionId,
        requestOrigin,
      }: {
        endpointId: string;
        compositionId?: string | null;
        requestOrigin?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.activateComposition(
        endpointId,
        compositionId ?? null,
        origin(requestOrigin, context),
      );
    },
    setSseStorageValue: (
      _root: unknown,
      { key, value }: { key: string; value: unknown },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.storageSet(key, value, "graphql");
    },
    compareAndSetSseStorageValue: (
      _root: unknown,
      {
        key,
        expectedVersion,
        value,
      }: { key: string; expectedVersion?: number | null; value: unknown },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.storageCompareAndSet(
        key,
        expectedVersion ?? null,
        value,
        "graphql",
      );
    },
    incrementSseStorageValue: (
      _root: unknown,
      { key, delta }: { key: string; delta: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.storageIncrement(key, delta, "graphql");
    },
    deleteSseStorageValue: (
      _root: unknown,
      { key }: { key: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.storageDelete(key);
    },
    resolveSseBreakpoint: (
      _root: unknown,
      { input }: { input: Parameters<SseService["resolveBreakpoint"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.resolveBreakpoint(input);
    },
    clearSseHistory: (
      _root: unknown,
      {
        ids,
        endpointId,
      }: { ids?: string[] | null; endpointId?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.clearHistory({ ids, endpointId });
    },
    testSseScript: (
      _root: unknown,
      { input }: { input: Parameters<SseService["testScript"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.testScript(input);
    },
    saveSseHistoryViewSettings: (
      _root: unknown,
      {
        input,
      }: { input: Parameters<SseService["saveHistoryViewSettings"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveHistoryViewSettings(input);
    },
    saveSseHistoryColumnPreset: (
      _root: unknown,
      {
        input,
      }: { input: Parameters<SseService["saveHistoryColumnPreset"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveHistoryColumnPreset(input);
    },
    deleteSseHistoryColumnPreset: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteHistoryColumnPreset(id);
    },
    saveSseHistorySavedFilter: (
      _root: unknown,
      { input }: { input: Parameters<SseService["saveHistorySavedFilter"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveHistorySavedFilter(input);
    },
    deleteSseHistorySavedFilter: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteHistorySavedFilter(id);
    },
  },
  Subscription: {
    sseEndpointsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeEndpoints();
      },
      resolve: (payload: unknown) => payload,
    },
    sseStorageChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeStorage();
      },
      resolve: (payload: unknown) => payload,
    },
    sseBreakpointsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeBreakpoints();
      },
      resolve: (payload: unknown) => payload,
    },
    sseHistoryChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeHistory();
      },
      resolve: (payload: unknown) => payload,
    },
    sseRequestHistoryChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeRequestHistory();
      },
      resolve: (payload: unknown) => payload,
    },
    sseEventHistoryChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeEventHistory();
      },
      resolve: (payload: unknown) => payload,
    },
  },
});
