import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SseHistoryEventsTable } from "./sse-history-events-table";
import type { SseHistoryEvent, SseHistoryRequest } from "./types";

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const stream: SseHistoryRequest = {
  id: "stream-1",
  endpointId: "endpoint-1",
  endpointName: "Chat",
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
  responseHeaders: [],
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

const eventRecord: SseHistoryEvent = {
  id: "event-1",
  requestId: stream.id,
  sequence: 1,
  logicalIndex: 0,
  stage: "SOURCE",
  correlationId: "correlation-event-1",
  eventName: "display_card",
  data: '{"title":"Hello"}',
  eventId: "message-1",
  retryMs: null,
  dropped: false,
  split: false,
  fanOutIndex: null,
  truncated: false,
  createdAt: "2026-08-30T12:00:00.100Z",
  request: stream,
};

afterEach(cleanup);

describe("SseHistoryEventsTable", () => {
  test("expands an event row inline without opening its stream", () => {
    render(
      <SseHistoryEventsTable
        columns={["createdAt", "eventName", "stage", "data"]}
        rows={[eventRecord]}
      />,
    );

    const row = screen.getByRole("button", {
      name: "display_card Source event",
    });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("correlation-event-1")).toBeNull();

    fireEvent.click(row);

    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("correlation-event-1")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "View Stream" }).getAttribute("href"),
    ).toBe("/sse/history/stream-1");

    fireEvent.keyDown(row, { key: " " });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });
});
