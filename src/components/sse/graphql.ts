export const SSE_COMPOSITION_FIELDS = `
  id name statusCode headers { name value } createdAt updatedAt
  blocks {
    id kind delayMs script customEvent { eventName data eventId retryMs }
    template {
      id endpointId name eventName data eventId retryMs retryMsTemplate
      fields { id key label helpText type required defaultValue }
    }
    templateValues { fieldId value }
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

export const SSE_HISTORY_REQUEST_SUMMARY_FIELDS = `
  id endpointId endpointName mode status method requestUrl upstreamStatus responseStatus
  breakpointResolution outcome error storedBytes truncated eventCount startedAt firstEventAt finishedAt durationMs
`;

export const SSE_HISTORY_EVENT_FIELDS = `
  id requestId sequence logicalIndex stage correlationId eventName data eventId retryMs
  dropped split fanOutIndex truncated createdAt
`;

export const SSE_ENDPOINTS_QUERY = `query SseEndpointsPage {
  sseEndpoints { id publicUrl name description mode forwardUrl activeMockCompositionId heartbeatEnabled heartbeatIntervalMs }
}`;

export const SSE_ENDPOINT_DETAIL_QUERY = `query SseEndpointDetail($id: ID!, $includeMocks: Boolean! = true) {
  sseEndpoint(id: $id) { ${SSE_ENDPOINT_FIELDS} }
  sseMockEventTemplates(endpointId: $id) @include(if: $includeMocks) {
    id endpointId name eventName data eventId retryMs retryMsTemplate
    fields { id key label helpText type required defaultValue }
    createdAt updatedAt
  }
  sseMockCompositions(endpointId: $id) @include(if: $includeMocks) { ${SSE_COMPOSITION_FIELDS} }
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

export const SSE_HISTORY_QUERY = `query SseHistoryPage($input: SseHistoryQueryInput!, $view: SseHistoryView!, $includeMetadata: Boolean! = true, $includeFacets: Boolean! = true) {
  sseHistory(input: $input) {
    view nextCursor matchingCount totalCount
    streams { ${SSE_HISTORY_REQUEST_SUMMARY_FIELDS} }
    events {
      ${SSE_HISTORY_EVENT_FIELDS}
      request { ${SSE_HISTORY_REQUEST_SUMMARY_FIELDS} }
    }
  }
  sseEndpoints @include(if: $includeFacets) { id name mode publicUrl }
  sseHistoryFacets @include(if: $includeFacets)
  sseHistoryViewSettings(view: $view) @include(if: $includeMetadata) { view columns timeFormat activeColumnPresetId activeSavedFilterId }
  sseHistoryColumnPresets(view: $view) @include(if: $includeMetadata) { id view name columns isDefault createdAt updatedAt }
  sseHistorySavedFilters(view: $view) @include(if: $includeMetadata) { id view name definition createdAt updatedAt }
}`;

export const SSE_HISTORY_DETAIL_QUERY = `query SseHistoryDetail($id: ID!, $first: Int, $before: Int, $after: Int, $latest: Boolean = false, $knownRanges: [SseHistorySequenceRangeInput!]) {
  sseHistoryRequest(id: $id) {
    ${SSE_HISTORY_REQUEST_FIELDS}
    events(first: $first, beforeSequence: $before, afterSequence: $after, latest: $latest, knownRanges: $knownRanges) { ${SSE_HISTORY_EVENT_FIELDS} }
  }
}`;
