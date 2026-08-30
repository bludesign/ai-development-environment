import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SseHistoryStreamsTable } from "./sse-history-page";
import type { SseHistoryRequest } from "./types";

function stream(
  id: string,
  endpointName: string,
  startedAt: string,
): SseHistoryRequest {
  return {
    id,
    endpointId: `endpoint-${id}`,
    endpointName,
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
    startedAt,
    firstEventAt: startedAt,
    finishedAt: startedAt,
    durationMs: 1000,
  };
}

const rows = [
  stream("stream-1", "Chat", "2026-08-30T12:00:00.000Z"),
  stream("stream-2", "Product", "2026-08-30T11:00:00.000Z"),
  stream("stream-3", "Alerts", "2026-08-29T12:00:00.000Z"),
];

afterEach(cleanup);

describe("SseHistoryStreamsTable", () => {
  test("groups streams by day and supports Console-style edit selection", () => {
    const openStream = vi.fn();
    const removeColumn = vi.fn();

    function Subject() {
      const [selected, setSelected] = useState<Set<string>>(new Set());
      return (
        <SseHistoryStreamsTable
          columns={["startedAt", "endpoint", "status"]}
          editMode
          hour12
          onRemoveColumn={removeColumn}
          openStream={openStream}
          rows={rows}
          selected={selected}
          setSelected={setSelected}
        />
      );
    }

    render(<Subject />);

    expect(screen.getByText("Sunday, August 30, 2026")).toBeDefined();
    expect(screen.getByText("Saturday, August 29, 2026")).toBeDefined();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select Sunday, August 30, 2026",
      }),
    );
    expect(
      screen
        .getByRole("checkbox", { name: "Select Chat" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: "Select Product" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Status column" }),
    );
    expect(removeColumn).toHaveBeenCalledWith("status");

    fireEvent.click(screen.getByRole("link", { name: "View Chat stream" }));
    expect(openStream).toHaveBeenCalledWith("stream-1");
  });
});
