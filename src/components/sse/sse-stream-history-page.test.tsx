import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { SseStreamHistoryPage } from "./sse-stream-history-page";
const state = vi.hoisted(() => ({
  reload: undefined as undefined | (() => Promise<void>),
}));
vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
vi.mock("./use-sse-live-reload", () => ({
  useSseLiveReload: (_scope: string, load: () => Promise<void>) => {
    state.reload = load;
  },
}));
vi.mock("./sse-shell", () => ({
  SsePageShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("./sse-history-page", () => ({
  SseStreamHistoryDetails: ({
    request,
  }: {
    request: { events: Array<{ sequence: number }> };
  }) => (
    <div>
      {request.events.map((event) => (
        <p key={event.sequence}>Event {event.sequence}</p>
      ))}
    </div>
  ),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
const request = vi.mocked(controlPlaneRequest);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
test("bounds initial history, recovers a late lower sequence, and retains older pages", async () => {
  let retained = Array.from({ length: 500 }, (_, sequence) => ({
    id: String(sequence),
    sequence,
  })).filter((event) => event.sequence !== 450);
  request.mockImplementation(async (_query, input) => {
    const vars = input as {
      first: number;
      latest?: boolean;
      before?: number;
      after?: number;
      knownRanges?: Array<{ fromSequence: number; throughSequence: number }>;
    };
    let events = retained.filter(
      (event) =>
        (vars.before == null || event.sequence < vars.before) &&
        (vars.after == null || event.sequence > vars.after) &&
        !vars.knownRanges?.some(
          (range) =>
            event.sequence >= range.fromSequence &&
            event.sequence <= range.throughSequence,
        ),
    );
    events =
      vars.latest || vars.before != null
        ? events.slice(-vars.first)
        : events.slice(0, vars.first);
    return {
      sseHistoryRequest: {
        id: "stream-1",
        endpointName: "Example",
        requestUrl: "/events",
        method: "GET",
        eventCount: retained.length,
        events,
      },
    } as never;
  });
  const view = render(<SseStreamHistoryPage requestId="stream-1" />);
  await screen.findByText("Event 499");
  expect(screen.queryByText("Event 0")).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]).toMatchObject({ first: 200, latest: true });
  retained = [
    ...retained,
    { id: "450", sequence: 450 },
    { id: "500", sequence: 500 },
  ].sort((a, b) => a.sequence - b.sequence);
  await act(async () => state.reload?.());
  expect(screen.getByText("Event 450")).toBeTruthy();
  expect(screen.getAllByText("Event 499")).toHaveLength(1);
  expect(screen.getByText("Event 500")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
  await screen.findByText("Event 99");
  await act(async () => state.reload?.());
  expect(screen.getByText("Event 99")).toBeTruthy();
  let signal: AbortSignal | undefined;
  request.mockImplementationOnce((_query, _input, options) => {
    signal = options?.signal;
    return new Promise(() => undefined);
  });
  act(() => {
    void state.reload?.();
  });
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
