export const SSE_ENDPOINT_MODES = ["FORWARD", "MOCK", "BREAKPOINT"] as const;
export const SSE_BUFFER_MODES = [
  "STANDARD",
  "CONCATENATE",
  "PRESERVE_FRAMES",
] as const;
export const SSE_MOCK_COMPLETIONS = ["CLOSE", "HOLD", "LOOP"] as const;
export const SSE_MOCK_BLOCK_KINDS = ["EVENT", "DELAY", "SCRIPT"] as const;
export const SSE_MOCK_TEMPLATE_FIELD_TYPES = [
  "TEXT",
  "NUMBER",
  "BOOLEAN",
  "JSON",
] as const;
export const SSE_HISTORY_VIEWS = ["STREAMS", "EVENTS"] as const;
export const SSE_HISTORY_EVENT_STAGES = [
  "SOURCE",
  "EMITTED",
  "DROPPED",
] as const;

export type SseEndpointMode = (typeof SSE_ENDPOINT_MODES)[number];
export type SseBufferMode = (typeof SSE_BUFFER_MODES)[number];
export type SseMockCompletion = (typeof SSE_MOCK_COMPLETIONS)[number];
export type SseMockBlockKind = (typeof SSE_MOCK_BLOCK_KINDS)[number];
export type SseMockTemplateFieldType =
  (typeof SSE_MOCK_TEMPLATE_FIELD_TYPES)[number];
export type SseHistoryView = (typeof SSE_HISTORY_VIEWS)[number];
export type SseHistoryEventStage = (typeof SSE_HISTORY_EVENT_STAGES)[number];

export type SseHeader = { name: string; value: string };

export type SseMockTemplateField = {
  id: string;
  key: string;
  label: string;
  helpText: string;
  type: SseMockTemplateFieldType;
  required: boolean;
  defaultValue: string | null;
};

export type SseMockTemplateFieldInput = {
  id?: string | null;
  key: string;
  label: string;
  helpText?: string | null;
  type: SseMockTemplateFieldType;
  required: boolean;
  defaultValue?: string | null;
};

export type SseMockTemplateValue = {
  fieldId: string;
  value: string;
};

export type SseEvent = {
  event?: string | null;
  data: string;
  id?: string | null;
  retry?: number | null;
  dataLines?: string[];
  /** False for SSE control frames that must not dispatch a client message. */
  dispatch?: boolean;
};

const SSE_NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function validateSseStreamingStatus(
  value: number,
  label = "SSE response status",
): number {
  if (
    !Number.isInteger(value) ||
    value < 200 ||
    value > 599 ||
    SSE_NULL_BODY_STATUSES.has(value)
  ) {
    throw new Error(
      `${label} must be an HTTP status between 200 and 599 that permits a response body`,
    );
  }
  return value;
}

export type SseSplitDirective = {
  target: "DELIVERY" | "HISTORY" | "BOTH" | "delivery" | "history" | "both";
  offset: number;
  separatorLength?: number;
  discard?: number;
};

export type SseScriptEventResult = {
  events?: SseEvent[] | SseEvent | null;
  split?: SseSplitDirective | SseSplitDirective[];
  splits?: SseSplitDirective[];
};

export type SseMockBlockInput = {
  id?: string | null;
  kind: SseMockBlockKind;
  templateId?: string | null;
  templateValues?: SseMockTemplateValue[] | null;
  customEvent?: {
    eventName?: string | null;
    data: string;
    eventId?: string | null;
    retryMs?: number | null;
  } | null;
  delayMs?: number | null;
  script?: string | null;
};

export type SseMockCompositionInput = {
  name: string;
  statusCode?: number | null;
  headers?: SseHeader[] | null;
  blocks: SseMockBlockInput[];
};

export type SseEndpointInput = {
  name: string;
  description?: string | null;
  forwardUrl: string;
  mode?: SseEndpointMode | null;
  requestScript?: string | null;
  responseScript?: string | null;
  activeMockCompositionId?: string | null;
  deliveryBufferMode?: SseBufferMode | null;
  historyBufferMode?: SseBufferMode | null;
  breakpointTimeoutMs?: number | null;
  heartbeatEnabled?: boolean | null;
  heartbeatIntervalMs?: number | null;
  mockCompletion?: SseMockCompletion | null;
  requestScriptTimeoutMs?: number | null;
  mockScriptTimeoutMs?: number | null;
  responseScriptTimeoutMs?: number | null;
  scriptMemoryLimitMb?: number | null;
  fetchTimeoutMs?: number | null;
  requestBodyLimitBytes?: number | null;
  eventDataLimitBytes?: number | null;
  streamHistoryLimitBytes?: number | null;
  retentionDays?: number | null;
  retentionEventLimit?: number | null;
};

export type SseHistoryQueryInput = {
  view?: SseHistoryView | null;
  first?: number | null;
  after?: string | null;
  endpointId?: string | null;
  modes?: SseEndpointMode[] | null;
  statuses?: string[] | null;
  eventNames?: string[] | null;
  stages?: SseHistoryEventStage[] | null;
  search?: string | null;
  searchMode?: "TEXT" | "GLOB" | "REGEX" | null;
  caseSensitive?: boolean | null;
};

export type SseBreakpointResolutionInput = {
  id: string;
  version: number;
  resolution: "FORWARD" | "SAVED_MOCK" | "AD_HOC";
  mockCompositionId?: string | null;
  adHocComposition?: SseMockCompositionInput | null;
};

export type SseEndpointSnapshot = {
  id: string;
  token: string;
  name: string;
  description: string;
  mode: SseEndpointMode;
  forwardUrl: string;
  requestScript: string;
  responseScript: string;
  activeMockCompositionId: string | null;
  deliveryBufferMode: SseBufferMode;
  historyBufferMode: SseBufferMode;
  breakpointTimeoutMs: number;
  heartbeatEnabled: boolean;
  heartbeatIntervalMs: number;
  mockCompletion: SseMockCompletion;
  requestScriptTimeoutMs: number;
  mockScriptTimeoutMs: number;
  responseScriptTimeoutMs: number;
  scriptMemoryLimitMb: number;
  fetchTimeoutMs: number;
  requestBodyLimitBytes: number;
  eventDataLimitBytes: number;
  streamHistoryLimitBytes: number;
  retentionDays: number;
  retentionEventLimit: number;
  activeMockComposition: SseResolvedComposition | null;
};

export type SseResolvedComposition = {
  id: string;
  name: string;
  statusCode: number;
  headers: SseHeader[];
  blocks: Array<{
    id: string;
    kind: SseMockBlockKind;
    delayMs: number | null;
    script: string | null;
    customEvent: null | {
      eventName: string | null;
      data: string;
      eventId: string | null;
      retryMs: number | null;
    };
    template: null | {
      id: string;
      endpointId: string;
      name: string;
      eventName: string | null;
      data: string;
      eventId: string | null;
      retryMs: number | null;
      retryMsTemplate: string | null;
      fields: SseMockTemplateField[];
    };
    templateValues: SseMockTemplateValue[];
  }>;
};

export const SSE_DEFAULTS = {
  breakpointTimeoutMs: 300_000,
  heartbeatIntervalMs: 15_000,
  requestScriptTimeoutMs: 30_000,
  mockScriptTimeoutMs: 30_000,
  responseScriptTimeoutMs: 5_000,
  scriptMemoryLimitMb: 32,
  fetchTimeoutMs: 15_000,
  requestBodyLimitBytes: 2 * 1024 * 1024,
  eventDataLimitBytes: 512 * 1024,
  streamHistoryLimitBytes: 50 * 1024 * 1024,
  retentionDays: 30,
  retentionEventLimit: 100_000,
} as const;
