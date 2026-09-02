export type SseMode = "FORWARD" | "MOCK" | "BREAKPOINT";
export type SseBufferMode = "STANDARD" | "CONCATENATE" | "PRESERVE_FRAMES";
export type SseHistoryView = "STREAMS" | "EVENTS";
export type SseHistoryStage = "SOURCE" | "EMITTED" | "DROPPED";

export type SseHeader = { name: string; value: string };

export type SseMockTemplateField = {
  id: string;
  key: string;
  label: string;
  helpText: string;
  type: "TEXT" | "NUMBER" | "BOOLEAN" | "JSON";
  required: boolean;
  defaultValue: string | null;
};

export type SseMockTemplateValue = { fieldId: string; value: string };

export type SseMockTemplate = {
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

export type SseMockBlock = {
  id: string;
  kind: "EVENT" | "DELAY" | "SCRIPT";
  delayMs: number | null;
  script: string | null;
  customEvent: {
    eventName: string | null;
    data: string;
    eventId: string | null;
    retryMs: number | null;
  } | null;
  template: SseMockTemplate | null;
  templateValues: SseMockTemplateValue[];
};

export type SseMockComposition = {
  id: string;
  name: string;
  statusCode: number;
  headers: SseHeader[];
  blocks: SseMockBlock[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type SseEndpoint = {
  id: string;
  token: string;
  publicUrl: string;
  name: string;
  description: string;
  mode: SseMode;
  forwardUrl: string;
  requestScript: string;
  responseScript: string;
  activeMockCompositionId: string | null;
  activeMockComposition: SseMockComposition | null;
  deliveryBufferMode: SseBufferMode;
  historyBufferMode: SseBufferMode;
  breakpointTimeoutMs: number;
  heartbeatEnabled: boolean;
  heartbeatIntervalMs: number;
  mockCompletion: "CLOSE" | "HOLD" | "LOOP";
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
  createdAt: string;
  updatedAt: string;
};

export type SseStorageEntry = {
  key: string;
  value: unknown;
  version: number;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SseHistoryEvent = {
  id: string;
  requestId: string;
  sequence: number;
  logicalIndex: number;
  stage: SseHistoryStage;
  correlationId: string;
  eventName: string;
  data: string;
  eventId: string | null;
  retryMs: number | null;
  dropped: boolean;
  split: boolean;
  fanOutIndex: number | null;
  truncated: boolean;
  createdAt: string;
  request?: SseHistoryRequest;
};

export type SseHistoryRequest = {
  id: string;
  endpointId: string | null;
  endpointName: string;
  endpointToken: string;
  mode: SseMode;
  status: string;
  method: string;
  requestUrl: string;
  requestHeaders: SseHeader[];
  requestBody: string | null;
  effectiveUrl: string | null;
  effectiveMethod: string | null;
  effectiveHeaders: SseHeader[];
  effectiveBody: string | null;
  upstreamStatus: number | null;
  upstreamHeaders: SseHeader[];
  responseStatus: number | null;
  responseHeaders: SseHeader[];
  breakpointResolution: string | null;
  outcome: string | null;
  error: string | null;
  configSnapshot: unknown;
  storedBytes: number;
  truncated: boolean;
  eventCount: number;
  startedAt: string;
  firstEventAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  events?: SseHistoryEvent[];
};

export type SseBreakpoint = {
  id: string;
  requestId: string;
  endpointId: string | null;
  status: string;
  version: number;
  resolution: string | null;
  mockCompositionId: string | null;
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
  request: SseHistoryRequest;
};
