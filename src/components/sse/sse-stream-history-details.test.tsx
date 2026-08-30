import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SseStreamHistoryDetails } from "./sse-history-page";
import type { SseHistoryEvent, SseHistoryRequest } from "./types";

vi.mock("next-intl", () => ({ useLocale: () => "en" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

const request: SseHistoryRequest = {
  id: "stream-1",
  endpointId: "endpoint-1",
  endpointName: "Product feed",
  endpointToken: "token",
  mode: "FORWARD",
  status: "COMPLETED",
  method: "GET",
  requestUrl: "https://example.test/sse",
  requestHeaders: [],
  requestBody: null,
  effectiveUrl: "https://upstream.test/sse",
  effectiveMethod: "GET",
  effectiveHeaders: [],
  effectiveBody: null,
  upstreamStatus: 200,
  upstreamHeaders: [],
  responseStatus: 200,
  responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
  breakpointResolution: null,
  outcome: "COMPLETED",
  error: null,
  configSnapshot: {},
  storedBytes: 42,
  truncated: false,
  eventCount: 1,
  startedAt: "2026-08-30T12:00:00.000Z",
  firstEventAt: "2026-08-30T12:00:00.100Z",
  finishedAt: "2026-08-30T12:00:01.000Z",
  durationMs: 1000,
};

const event: SseHistoryEvent = {
  id: "event-1",
  requestId: request.id,
  sequence: 1,
  logicalIndex: 0,
  stage: "EMITTED",
  correlationId: "correlation-1",
  eventName: "display_card",
  data: '{"title":"Hello"}',
  eventId: "message-1",
  retryMs: null,
  dropped: false,
  split: false,
  fanOutIndex: null,
  truncated: false,
  createdAt: "2026-08-30T12:00:00.100Z",
};

afterEach(cleanup);

describe("SseStreamHistoryDetails", () => {
  test("offers to save retained output as a composition", () => {
    render(
      <SseStreamHistoryDetails request={{ ...request, events: [event] }} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Save as Composition" }),
    );

    expect(
      screen.getByRole("heading", { name: "Save Stream as Composition" }),
    ).toBeDefined();
    expect(
      screen.getByText(/Store 1 emitted events as one-off event blocks/),
    ).toBeDefined();
    expect(
      screen.getByRole("checkbox", { name: /Preserve event timing/ }),
    ).toBeDefined();
  });
});
