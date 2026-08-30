export const SSE_COMPOSITION_FIELDS = `
  id name statusCode headers { name value } createdAt updatedAt
  blocks {
    id kind delayMs script
    template { id endpointId name eventName data eventId retryMs }
  }
`;

export const SSE_ENDPOINT_FIELDS = `
  id token publicUrl name description mode forwardUrl requestScript responseScript
  activeMockCompositionId
  activeMockComposition { ${SSE_COMPOSITION_FIELDS} }
  deliveryBufferMode historyBufferMode breakpointTimeoutMs
  heartbeatEnabled heartbeatIntervalMs mockCompletion
  requestScriptTimeoutMs mockScriptTimeoutMs responseScriptTimeoutMs
  scriptMemoryLimitMb fetchTimeoutMs requestBodyLimitBytes eventDataLimitBytes
  streamHistoryLimitBytes retentionDays retentionEventLimit createdAt updatedAt
`;

export const SSE_HISTORY_REQUEST_FIELDS = `
  id endpointId endpointName endpointToken mode status method requestUrl
  requestHeaders { name value } requestBody effectiveUrl effectiveMethod
  effectiveHeaders { name value } effectiveBody upstreamStatus
  upstreamHeaders { name value } responseStatus responseHeaders { name value }
  breakpointResolution outcome error configSnapshot storedBytes truncated eventCount
  startedAt firstEventAt finishedAt durationMs
`;

export const SSE_HISTORY_EVENT_FIELDS = `
  id requestId sequence logicalIndex stage correlationId eventName data eventId retryMs
  dropped split fanOutIndex truncated createdAt
`;

export const SSE_ENDPOINTS_QUERY = `query SseEndpointsPage {
  sseEndpoints { ${SSE_ENDPOINT_FIELDS} }
}`;

export const SSE_ENDPOINT_DETAIL_QUERY = `query SseEndpointDetail($id: ID!) {
  sseEndpoint(id: $id) { ${SSE_ENDPOINT_FIELDS} }
  sseMockEventTemplates(endpointId: $id) {
    id endpointId name eventName data eventId retryMs createdAt updatedAt
  }
  sseMockCompositions(endpointId: $id) { ${SSE_COMPOSITION_FIELDS} }
}`;

export const SSE_STORAGE_QUERY = `query SseStoragePage {
  sseStorageEntries { key value version updatedBy createdAt updatedAt }
}`;

export const SSE_BREAKPOINTS_QUERY = `query SseBreakpointsPage {
  sseBreakpoints(status: "WAITING") {
    id requestId endpointId status version resolution mockCompositionId expiresAt resolvedAt createdAt
    request { ${SSE_HISTORY_REQUEST_FIELDS} }
  }
  sseEndpoints { id name mode publicUrl activeMockCompositionId }
}`;

export const SSE_HISTORY_QUERY = `query SseHistoryPage($input: SseHistoryQueryInput!, $view: SseHistoryView!) {
  sseHistory(input: $input) {
    view nextCursor matchingCount totalCount
    streams { ${SSE_HISTORY_REQUEST_FIELDS} }
    events {
      ${SSE_HISTORY_EVENT_FIELDS}
      request { ${SSE_HISTORY_REQUEST_FIELDS} }
    }
  }
  sseEndpoints { id name mode publicUrl }
  sseHistoryFacets
  sseHistoryViewSettings(view: $view) { view columns timeFormat activeColumnPresetId activeSavedFilterId }
  sseHistoryColumnPresets(view: $view) { id view name columns isDefault createdAt updatedAt }
  sseHistorySavedFilters(view: $view) { id view name definition createdAt updatedAt }
}`;

export const SSE_HISTORY_DETAIL_QUERY = `query SseHistoryDetail($id: ID!) {
  sseHistoryRequest(id: $id) {
    ${SSE_HISTORY_REQUEST_FIELDS}
    events { ${SSE_HISTORY_EVENT_FIELDS} }
  }
}`;
