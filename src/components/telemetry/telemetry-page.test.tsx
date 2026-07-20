import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
const subscribe = vi.hoisted(() => vi.fn(() => vi.fn()));
const copyText = vi.hoisted(() => vi.fn());

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: request,
  controlPlaneSubscriptions: () => ({ subscribe }),
}));
vi.mock("@/lib/browser-utils", () => ({ copyText }));

import { TelemetryPage, telemetryApiDocumentation } from "./telemetry-page";

const settings = {
  localBaseUrlOverride: null,
  remoteBaseUrlOverride: null,
  consoleCollectionEnabled: true,
  analyticsCollectionEnabled: true,
  detectedLocalBaseUrl: "http://127.0.0.1:3000",
  detectedRemoteBaseUrl: "https://events.example.com",
  effectiveLocalBaseUrl: "http://127.0.0.1:3000",
  effectiveRemoteBaseUrl: "https://events.example.com",
  updatedAt: "2026-07-20T16:00:00.000Z",
};

const log = {
  id: "log-1",
  entryType: "CONSOLE",
  clientTime: "2026-07-20T16:30:00.000Z",
  receivedAt: "2026-07-20T16:30:01.000Z",
  deviceIp: "203.0.113.4",
  message: "Checkout completed",
  level: "info",
  category: "checkout",
  eventName: null,
  eventKind: null,
  screenName: null,
  buildId: "build-1",
  sessionId: "session-1",
  attributes: { device: { model: "iPhone" } },
  defaultParameters: {},
  additionalParameters: {},
  highlightColor: null,
  separatorKind: null,
  separatorName: null,
};

let timelineItems = [log];

beforeEach(() => {
  vi.clearAllMocks();
  timelineItems = [log];
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  request.mockImplementation(
    (
      operation: string,
      variables?: {
        input?: { columns?: string[]; timeFormat?: "12" | "24" };
      },
    ) => {
      if (operation.includes("query TelemetryConfiguration")) {
        return {
          telemetrySettings: settings,
          telemetryViewSettings: {
            view: "CONSOLE",
            columns: [
              "time",
              "level",
              "category",
              "message",
              "buildId",
              "sessionId",
            ],
            timeFormat: "12",
            activeColumnPresetId: null,
            activeSavedFilterId: null,
          },
          telemetryColumnPresets: [],
          telemetrySavedFilters: [],
          telemetryFacets: {
            level: ["info"],
            category: ["checkout"],
            deviceIp: ["203.0.113.4"],
            buildId: ["build-1"],
            sessionId: ["session-1"],
          },
          telemetryFields: [
            "message",
            "level",
            "category",
            "buildId",
            "sessionId",
            "attributes.device.model",
          ],
        };
      }
      if (operation.includes("query TelemetryTimeline")) {
        return {
          telemetryTimeline: {
            items: timelineItems,
            nextCursor: null,
            matchingCount: timelineItems.length,
            totalCount: timelineItems.length,
          },
        };
      }
      if (operation.includes("mutation SaveTelemetryViewSettings")) {
        return {
          saveTelemetryViewSettings: {
            view: "CONSOLE",
            columns: variables?.input?.columns ?? [
              "time",
              "level",
              "category",
              "message",
              "buildId",
              "sessionId",
            ],
            timeFormat: variables?.input?.timeFormat ?? "12",
            activeColumnPresetId: null,
            activeSavedFilterId: null,
          },
        };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    },
  );
});

afterEach(() => cleanup());

describe("TelemetryPage", () => {
  test("renders the console timeline, facets, counts, and expanded dictionaries", async () => {
    render(<TelemetryPage view="CONSOLE" />);

    expect(
      await screen.findByRole("heading", { name: "Console Logs" }),
    ).toBeTruthy();
    expect(await screen.findByText("Checkout completed")).toBeTruthy();
    expect(
      screen.getByText("Checkout completed").closest("td")?.className,
    ).toContain("py-1.5");
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Level$/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /^Message/ })).toBeTruthy();

    fireEvent.click(screen.getByText("Checkout completed"));
    expect(await screen.findByText("203.0.113.4")).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: "Clear highlight" }).className,
    ).toContain("size-5");
    expect(screen.getByText("device.model")).toBeTruthy();
    const addColumn = screen.getByRole("button", {
      name: "Add device.model column",
    });
    fireEvent.click(addColumn);
    const removeColumn = await screen.findByRole("button", {
      name: "Remove device.model column",
    });
    expect(
      screen.getByRole("columnheader", { name: /device\.model/ }),
    ).toBeTruthy();
    fireEvent.click(removeColumn);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Remove device.model column",
        }),
      ).toBeNull(),
    );
  });

  test("does not expand a row when a context-menu action is selected", async () => {
    render(<TelemetryPage view="CONSOLE" />);
    const message = await screen.findByText("Checkout completed");

    fireEvent.contextMenu(message);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy value" }),
    );

    expect(copyText).toHaveBeenCalledWith("Checkout completed");
    expect(screen.queryByText("203.0.113.4")).toBeNull();
  });

  test("reconciles newly ingested entries from the live subscription", async () => {
    render(<TelemetryPage view="CONSOLE" />);
    await screen.findByText("Checkout completed");
    const liveLog = {
      ...log,
      id: "log-2",
      clientTime: "2026-07-20T16:31:00.000Z",
      receivedAt: "2026-07-20T16:31:01.000Z",
      message: "Live telemetry arrived",
    };
    timelineItems = [liveLog, log];
    const subscriptionCalls = subscribe.mock.calls as unknown as Array<
      [
        { query: string },
        {
          next: (payload: {
            data: {
              telemetryEntriesChanged: { ids: string[]; reason: string };
            };
          }) => void;
        },
      ]
    >;
    const call = subscriptionCalls.find(([operation]) =>
      String((operation as { query?: string }).query).includes(
        "telemetryEntriesChanged",
      ),
    );
    expect(call).toBeTruthy();
    const sink = call![1];

    await act(async () => {
      sink.next({
        data: {
          telemetryEntriesChanged: { ids: [liveLog.id], reason: "INGESTED" },
        },
      });
    });

    expect(await screen.findByText("Live telemetry arrived")).toBeTruthy();
    expect(screen.getByText("2 of 2")).toBeTruthy();
  });

  test("sends text, glob, or regex search through the shared timeline input", async () => {
    render(<TelemetryPage view="CONSOLE" />);
    const search = await screen.findByRole("textbox", {
      name: "Search telemetry",
    });
    fireEvent.change(search, { target: { value: "Checkout" } });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("query TelemetryTimeline"),
        expect.objectContaining({
          input: expect.objectContaining({
            search: "Checkout",
            searchMode: "TEXT",
          }),
        }),
      ),
    );
  });

  test("shows and copies page-specific REST API documentation", async () => {
    render(<TelemetryPage view="CONSOLE" />);
    await screen.findByText("Checkout completed");

    fireEvent.click(screen.getByRole("button", { name: "API help" }));
    expect(
      await screen.findByRole("heading", { name: "Send console logs" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /http:\/\/127\.0\.0\.1:3000\/api\/telemetry\/console-logs/,
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown docs" }));
    expect(copyText).toHaveBeenCalledWith(
      expect.stringContaining("# Console logs API"),
    );
    expect(copyText).toHaveBeenCalledWith(
      expect.stringContaining('"attributes"'),
    );
    expect(
      telemetryApiDocumentation(
        "ANALYTICS",
        "http://127.0.0.1:3000",
        "https://events.example.com",
      ),
    ).toContain('"defaultParameters"');
  });

  test("opens the shadcn advanced-filter Sheet and column manager", async () => {
    render(<TelemetryPage view="CONSOLE" />);
    await screen.findByText("Checkout completed");

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(
      await screen.findByRole("heading", { name: "Advanced filters" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "Manage columns",
    );
  });
});
