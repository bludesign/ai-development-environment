import * as z from "zod/v4";

import type {
  SseBreakpointResolutionInput,
  SseEndpointInput,
  SseMockCompositionInput,
  SseService,
} from "@/services/sse";

import {
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  WRITE_EXTERNAL_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";

const HeaderSchema = z.object({ name: z.string().min(1), value: z.string() });
const EventSchema = z.object({
  eventName: z.string().nullable().optional(),
  data: z.string(),
  eventId: z.string().nullable().optional(),
  retryMs: z.number().int().nullable().optional(),
});
const EndpointInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  forwardUrl: z.url(),
  mode: z.enum(["FORWARD", "MOCK", "BREAKPOINT"]).optional(),
  requestScript: z.string().optional(),
  responseScript: z.string().optional(),
  activeMockCompositionId: z.string().nullable().optional(),
  deliveryBufferMode: z
    .enum(["STANDARD", "CONCATENATE", "PRESERVE_FRAMES"])
    .optional(),
  historyBufferMode: z
    .enum(["STANDARD", "CONCATENATE", "PRESERVE_FRAMES"])
    .optional(),
  breakpointTimeoutMs: z.number().int().optional(),
  heartbeatEnabled: z.boolean().optional(),
  heartbeatIntervalMs: z.number().int().optional(),
  mockCompletion: z.enum(["CLOSE", "HOLD", "LOOP"]).optional(),
  requestScriptTimeoutMs: z.number().int().optional(),
  mockScriptTimeoutMs: z.number().int().optional(),
  responseScriptTimeoutMs: z.number().int().optional(),
  scriptMemoryLimitMb: z.number().int().optional(),
  fetchTimeoutMs: z.number().int().optional(),
  requestBodyLimitBytes: z.number().int().optional(),
  eventDataLimitBytes: z.number().int().optional(),
  streamHistoryLimitBytes: z.number().int().optional(),
  retentionDays: z.number().int().optional(),
  retentionEventLimit: z.number().int().optional(),
});
const BlockSchema = z.object({
  id: z.string().nullable().optional(),
  kind: z.enum(["EVENT", "DELAY", "SCRIPT"]),
  templateId: z.string().nullable().optional(),
  customEvent: EventSchema.nullable().optional(),
  delayMs: z.number().int().nullable().optional(),
  script: z.string().nullable().optional(),
});
const CompositionSchema = z.object({
  name: z.string().min(1),
  statusCode: z.number().int().min(100).max(599).optional(),
  headers: z.array(HeaderSchema).optional(),
  blocks: z.array(BlockSchema).max(1_000),
});
const ObjectOutput = z.object({ value: z.unknown() });

export function createSseToolGroup(service: SseService): BuiltInToolGroup {
  return {
    id: "builtin:sse",
    name: "SSE Endpoints",
    children: [],
    tools: [
      defineTool({
        name: "sse_endpoint_list",
        title: "List SSE endpoints",
        description: "List hosted SSE proxy, mock, and breakpoint endpoints.",
        inputSchema: z.object({ origin: z.string().nullable().optional() }),
        outputSchema: z.object({ endpoints: z.array(z.unknown()) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ origin }) => ({
          endpoints: await service.endpoints(origin),
        }),
      }),
      defineTool({
        name: "sse_endpoint_get",
        title: "Get SSE endpoint",
        description: "Get one SSE endpoint and its effective public URL.",
        inputSchema: z.object({
          id: z.string(),
          origin: z.string().nullable().optional(),
        }),
        outputSchema: z.object({ endpoint: z.unknown() }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ id, origin }) => ({
          endpoint: await service.endpoint(id, origin),
        }),
      }),
      defineTool({
        name: "sse_endpoint_create",
        title: "Create SSE endpoint",
        description:
          "Create a hosted SSE endpoint. New endpoints default to Forward mode.",
        inputSchema: EndpointInputSchema,
        outputSchema: z.object({ endpoint: z.unknown() }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          endpoint: await service.createEndpoint(input as SseEndpointInput),
        }),
      }),
      defineTool({
        name: "sse_endpoint_update",
        title: "Update SSE endpoint",
        description: "Replace the editable configuration for an SSE endpoint.",
        inputSchema: z.object({
          id: z.string(),
          endpoint: EndpointInputSchema,
        }),
        outputSchema: z.object({ endpoint: z.unknown() }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ id, endpoint }) => ({
          endpoint: await service.updateEndpoint(
            id,
            endpoint as SseEndpointInput,
          ),
        }),
      }),
      defineTool({
        name: "sse_endpoint_set_mode",
        title: "Set SSE endpoint mode",
        description:
          "Switch future requests to Forward, Mock, or Breakpoint mode.",
        inputSchema: z.object({
          id: z.string(),
          mode: z.enum(["FORWARD", "MOCK", "BREAKPOINT"]),
        }),
        outputSchema: z.object({ endpoint: z.unknown() }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ id, mode }) => ({
          endpoint: await service.setMode(id, mode),
        }),
      }),
      defineTool({
        name: "sse_endpoint_rotate_token",
        title: "Rotate SSE endpoint URL",
        description:
          "Replace the endpoint's opaque token and invalidate the old public URL.",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ endpoint: z.unknown() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ id }) => ({
          endpoint: await service.rotateToken(id),
        }),
      }),
      defineTool({
        name: "sse_endpoint_delete",
        title: "Delete SSE endpoint",
        description:
          "Delete an endpoint while preserving its detached history snapshots.",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ deleted: z.boolean() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ id }) => ({
          deleted: await service.deleteEndpoint(id),
        }),
      }),
      defineTool({
        name: "sse_mock_template_list",
        title: "List SSE mock templates",
        description: "List reusable SSE events belonging to one endpoint.",
        inputSchema: z.object({ endpointId: z.string() }),
        outputSchema: z.object({ templates: z.array(z.unknown()) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ endpointId }) => ({
          templates: await service.eventTemplates(endpointId),
        }),
      }),
      defineTool({
        name: "sse_mock_template_save",
        title: "Save SSE mock template",
        description: "Create or update a reusable SSE mock event.",
        inputSchema: z.object({
          endpointId: z.string(),
          id: z.string().nullable().optional(),
          name: z.string(),
          eventName: z.string().nullable().optional(),
          data: z.string(),
          eventId: z.string().nullable().optional(),
          retryMs: z.number().int().nullable().optional(),
        }),
        outputSchema: ObjectOutput,
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ endpointId, ...input }) => ({
          value: await service.saveEventTemplate(endpointId, input),
        }),
      }),
      defineTool({
        name: "sse_mock_template_delete",
        title: "Delete SSE mock template",
        description: "Delete a reusable mock event.",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ deleted: z.boolean() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ id }) => ({
          deleted: await service.deleteEventTemplate(id),
        }),
      }),
      defineTool({
        name: "sse_mock_composition_list",
        title: "List SSE mock compositions",
        description: "List saved response compositions for one SSE endpoint.",
        inputSchema: z.object({ endpointId: z.string() }),
        outputSchema: z.object({ compositions: z.array(z.unknown()) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ endpointId }) => ({
          compositions: await service.compositions(endpointId),
        }),
      }),
      defineTool({
        name: "sse_mock_composition_save",
        title: "Save SSE mock composition",
        description:
          "Create or update an ordered event, delay, and script composition.",
        inputSchema: z.object({
          endpointId: z.string(),
          id: z.string().nullable().optional(),
          composition: CompositionSchema,
        }),
        outputSchema: ObjectOutput,
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ endpointId, id, composition }) => ({
          value: await service.saveComposition(
            endpointId,
            composition as SseMockCompositionInput,
            id,
          ),
        }),
      }),
      defineTool({
        name: "sse_mock_composition_activate",
        title: "Activate SSE mock composition",
        description:
          "Select the saved composition used by future Mock-mode requests.",
        inputSchema: z.object({
          endpointId: z.string(),
          compositionId: z.string().nullable(),
        }),
        outputSchema: z.object({ endpoint: z.unknown() }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ endpointId, compositionId }) => ({
          endpoint: await service.activateComposition(
            endpointId,
            compositionId,
          ),
        }),
      }),
      defineTool({
        name: "sse_mock_composition_delete",
        title: "Delete SSE mock composition",
        description: "Delete a saved SSE mock composition.",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ deleted: z.boolean() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ id }) => ({
          deleted: await service.deleteComposition(id),
        }),
      }),
      defineTool({
        name: "sse_script_test",
        title: "Test SSE script",
        description:
          "Run asynchronous JavaScript with copy-on-write storage and report proposed writes.",
        inputSchema: z.object({
          source: z.string(),
          context: z.record(z.string(), z.unknown()).optional(),
          timeoutMs: z.number().int().optional(),
          memoryLimitMb: z.number().int().optional(),
          fetchTimeoutMs: z.number().int().optional(),
        }),
        outputSchema: ObjectOutput,
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
        handler: async (input) => ({ value: await service.testScript(input) }),
      }),
      defineTool({
        name: "sse_storage_list",
        title: "List SSE script storage",
        description:
          "List every visible global JSON storage entry and version.",
        inputSchema: z.object({}),
        outputSchema: z.object({ entries: z.array(z.unknown()) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async () => ({ entries: await service.storageEntries() }),
      }),
      defineTool({
        name: "sse_storage_get",
        title: "Get SSE script storage",
        description: "Read one global JSON storage value and its version.",
        inputSchema: z.object({ key: z.string() }),
        outputSchema: ObjectOutput,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ key }) => ({ value: await service.storageGet(key) }),
      }),
      defineTool({
        name: "sse_storage_set",
        title: "Set SSE script storage",
        description: "Create or replace a global JSON storage value.",
        inputSchema: z.object({ key: z.string(), value: z.unknown() }),
        outputSchema: ObjectOutput,
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ key, value }) => ({
          value: await service.storageSet(key, value, "mcp"),
        }),
      }),
      defineTool({
        name: "sse_storage_compare_and_set",
        title: "Compare and set SSE storage",
        description:
          "Atomically replace a value only when its version matches.",
        inputSchema: z.object({
          key: z.string(),
          expectedVersion: z.number().int().nullable(),
          value: z.unknown(),
        }),
        outputSchema: ObjectOutput,
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ key, expectedVersion, value }) => ({
          value: await service.storageCompareAndSet(
            key,
            expectedVersion,
            value,
            "mcp",
          ),
        }),
      }),
      defineTool({
        name: "sse_storage_increment",
        title: "Increment SSE script storage",
        description: "Atomically increment a numeric global storage value.",
        inputSchema: z.object({
          key: z.string(),
          delta: z.number().default(1),
        }),
        outputSchema: ObjectOutput,
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ key, delta }) => ({
          value: await service.storageIncrement(key, delta, "mcp"),
        }),
      }),
      defineTool({
        name: "sse_storage_delete",
        title: "Delete SSE script storage",
        description: "Delete a global storage value.",
        inputSchema: z.object({ key: z.string() }),
        outputSchema: z.object({ deleted: z.boolean() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ key }) => ({
          deleted: await service.storageDelete(key),
        }),
      }),
      defineTool({
        name: "sse_breakpoint_list",
        title: "List SSE breakpoints",
        description: "List waiting or resolved SSE breakpoints.",
        inputSchema: z.object({ status: z.string().nullable().optional() }),
        outputSchema: z.object({ breakpoints: z.array(z.unknown()) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ status }) => ({
          breakpoints: await service.breakpoints(status),
        }),
      }),
      defineTool({
        name: "sse_breakpoint_resolve",
        title: "Resolve SSE breakpoint",
        description:
          "Resolve a waiting breakpoint by forwarding or returning a saved/ad hoc mock.",
        inputSchema: z.object({
          id: z.string(),
          version: z.number().int(),
          resolution: z.enum(["FORWARD", "SAVED_MOCK", "AD_HOC"]),
          mockCompositionId: z.string().nullable().optional(),
          adHocComposition: CompositionSchema.nullable().optional(),
        }),
        outputSchema: ObjectOutput,
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          value: await service.resolveBreakpoint(
            input as SseBreakpointResolutionInput,
          ),
        }),
      }),
      defineTool({
        name: "sse_history_query",
        title: "Query SSE history",
        description:
          "Query stream or event history with endpoint and text filters.",
        inputSchema: z.object({
          view: z.enum(["STREAMS", "EVENTS"]).default("STREAMS"),
          first: z.number().int().min(1).max(500).default(100),
          after: z.string().nullable().optional(),
          endpointId: z.string().nullable().optional(),
          modes: z.array(z.enum(["FORWARD", "MOCK", "BREAKPOINT"])).optional(),
          statuses: z.array(z.string()).optional(),
          eventNames: z.array(z.string()).optional(),
          search: z.string().nullable().optional(),
          searchMode: z.enum(["TEXT", "GLOB", "REGEX"]).default("TEXT"),
          caseSensitive: z.boolean().default(false),
        }),
        outputSchema: ObjectOutput,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async (input) => ({ value: await service.history(input) }),
      }),
      defineTool({
        name: "sse_history_clear",
        title: "Clear SSE history",
        description:
          "Delete completed history by explicit request IDs or endpoint.",
        inputSchema: z.object({
          ids: z.array(z.string()).max(1_000).nullable().optional(),
          endpointId: z.string().nullable().optional(),
        }),
        outputSchema: z.object({ deletedCount: z.number().int() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async (input) => ({
          deletedCount: await service.clearHistory(input),
        }),
      }),
      defineTool({
        name: "sse_history_export",
        title: "Export SSE history",
        description:
          "Export all matching stream or event history as JSON, CSV, or Markdown.",
        inputSchema: z.object({
          format: z.enum(["JSON", "CSV", "MARKDOWN"]).default("JSON"),
          view: z.enum(["STREAMS", "EVENTS"]).default("STREAMS"),
          endpointId: z.string().nullable().optional(),
          modes: z.array(z.enum(["FORWARD", "MOCK", "BREAKPOINT"])).optional(),
          statuses: z.array(z.string()).optional(),
          eventNames: z.array(z.string()).optional(),
          search: z.string().nullable().optional(),
          searchMode: z.enum(["TEXT", "GLOB", "REGEX"]).default("TEXT"),
          caseSensitive: z.boolean().default(false),
        }),
        outputSchema: z.object({
          format: z.enum(["JSON", "CSV", "MARKDOWN"]),
          content: z.string(),
          rowCount: z.number().int(),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ format, ...input }) =>
          service.exportHistory(input, format),
      }),
    ],
  };
}
