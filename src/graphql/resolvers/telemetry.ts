import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  TelemetryFilterDefinition,
  TelemetryQueryInput,
  TelemetryService,
} from "@/services/telemetry";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

function detection(requestOrigin?: string | null) {
  return { requestOrigin: requestOrigin ?? null };
}

export const createTelemetryResolvers = (service: TelemetryService) => ({
  Query: {
    telemetryTimeline: (
      _root: unknown,
      { input }: { input: TelemetryQueryInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.timeline(input);
    },
    telemetryEntries: (
      _root: unknown,
      { ids }: { ids: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.entries(ids);
    },
    telemetryFacets: (
      _root: unknown,
      { view }: { view: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.facets(view);
    },
    telemetryFields: (
      _root: unknown,
      { view }: { view: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.fields(view);
    },
    telemetrySettings: (
      _root: unknown,
      { requestOrigin }: { requestOrigin?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.settings(detection(requestOrigin));
    },
    telemetryViewSettings: (
      _root: unknown,
      { view }: { view: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.viewSettings(view);
    },
    telemetryColumnPresets: (
      _root: unknown,
      { view }: { view: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.columnPresets(view);
    },
    telemetrySavedFilters: (
      _root: unknown,
      { view }: { view: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.savedFilters(view);
    },
  },
  Mutation: {
    saveTelemetrySettings: (
      _root: unknown,
      {
        input,
        requestOrigin,
      }: {
        input: Parameters<TelemetryService["saveSettings"]>[0];
        requestOrigin?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveSettings(input, detection(requestOrigin));
    },
    saveTelemetryViewSettings: (
      _root: unknown,
      { input }: { input: Parameters<TelemetryService["saveViewSettings"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveViewSettings(input);
    },
    saveTelemetryColumnPreset: (
      _root: unknown,
      { input }: { input: Parameters<TelemetryService["saveColumnPreset"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveColumnPreset(input);
    },
    deleteTelemetryColumnPreset: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteColumnPreset(id);
    },
    saveTelemetryFilter: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          id?: string | null;
          view: string;
          name: string;
          definition: TelemetryFilterDefinition;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveFilter(input);
    },
    deleteTelemetryFilter: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteFilter(id);
    },
    addTelemetrySeparator: (
      _root: unknown,
      { name }: { name?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.addSeparator(name);
    },
    updateTelemetryHighlight: (
      _root: unknown,
      { id, color }: { id: string; color?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.highlight(id, color ?? null);
    },
    clearSelectedTelemetry: (
      _root: unknown,
      {
        selection,
      }: { selection: Parameters<TelemetryService["clearSelected"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.clearSelected(selection);
    },
    clearTelemetry: (
      _root: unknown,
      {
        view,
        includeSeparators,
      }: { view: string; includeSeparators?: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.clearAll(view, includeSeparators);
    },
    clearTelemetryBeforeLatestSeparator: (
      _root: unknown,
      { view }: { view: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.clearBeforeLatestSeparator(view);
    },
  },
  Subscription: {
    telemetryEntriesChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
    },
    telemetrySettingsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeSettings();
      },
    },
  },
});
