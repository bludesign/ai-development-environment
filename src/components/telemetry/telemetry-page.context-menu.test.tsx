import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { serverUrlFixture } from "../../../test/fixtures/server-urls";
import { telemetryFields } from "@/services/telemetry/fields";
import { matchesTelemetryQuery } from "@/services/telemetry/matching";
import {
  DEFAULT_TELEMETRY_COLUMNS,
  type TelemetryEntryView,
  type TelemetryQueryInput,
  type TelemetryView,
} from "@/services/telemetry/types";

const request = vi.hoisted(() => vi.fn());
const copyText = vi.hoisted(() => vi.fn());

vi.mock("@/lib/control-plane-client", () => ({
  onControlPlaneRecovery: vi.fn(() => () => {}),
  controlPlaneRequest: request,
  controlPlaneSubscriptions: () => ({ subscribe: () => () => {} }),
}));
vi.mock("@/lib/browser-utils", () => ({ copyText }));
// These tests exercise the production exact-value matcher without loading its
// native regex dependency into the component test worker.
vi.mock("re2", () => ({ default: vi.fn() }));
vi.mock("@/hooks/use-server-url-settings", () => ({
  useServerUrlSettings: () => ({
    settings: serverUrlFixture,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import { TelemetryPage } from "./telemetry-page";

const attributes = {
  device: { model: "iPhone" },
  "literal.key": 0,
  enabled: false,
  payload: [{ z: 1, a: 2 }],
  empty: {},
  absent: null,
};

const log: TelemetryEntryView = {
  id: "console-1",
  entryType: "CONSOLE",
  clientTime: "2026-07-20T16:30:00.123Z",
  receivedAt: "2026-07-20T16:30:01.456Z",
  deviceIp: "203.0.113.4",
  message: "Checkout completed",
  level: "info",
  category: "checkout",
  eventName: null,
  eventKind: null,
  screenName: null,
  buildId: "build-1",
  sessionId: "session-1",
  attributes,
  defaultParameters: {},
  additionalParameters: {},
  highlightColor: null,
  separatorKind: null,
  separatorName: null,
};

const analytics: TelemetryEntryView = {
  ...log,
  id: "analytics-1",
  entryType: "ANALYTICS",
  message: null,
  level: null,
  category: null,
  eventKind: "product",
  eventName: "purchase_completed",
  screenName: "Checkout",
  attributes: {},
  defaultParameters: attributes,
  additionalParameters: { campaign: { source: "email" } },
};

let entries: TelemetryEntryView[];

beforeEach(() => {
  vi.clearAllMocks();
  entries = [log, analytics];
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  request.mockImplementation(
    (
      operation: string,
      variables: { view?: TelemetryView; input?: TelemetryQueryInput },
    ) => {
      if (operation.includes("query TelemetryConfiguration")) {
        const view = variables.view!;
        const visible = entries.filter((entry) =>
          view === "UNIFIED" ? true : entry.entryType === view,
        );
        const fields = [
          ...new Set(
            visible.flatMap((entry) => Object.keys(telemetryFields(entry))),
          ),
        ];
        return {
          telemetrySettings: {
            ...serverUrlFixture,
            consoleCollectionEnabled: true,
            analyticsCollectionEnabled: true,
          },
          telemetryViewSettings: {
            view,
            columns: DEFAULT_TELEMETRY_COLUMNS[view],
            timeFormat: "12",
            showBuildRunSeparators: true,
            activeColumnPresetId: null,
            activeSavedFilterId: null,
          },
          telemetryColumnPresets: [],
          telemetrySavedFilters: [],
          telemetryFacets: Object.fromEntries(
            [
              "source",
              "level",
              "category",
              "eventKind",
              "eventName",
              "screenName",
              "deviceIp",
              "buildId",
              "sessionId",
              "levelKind",
            ].map((field) => [
              field,
              [
                ...new Set(
                  visible
                    .map((entry) => telemetryFields(entry)[field])
                    .filter((value) => typeof value === "string"),
                ),
              ],
            ]),
          ),
          telemetryIdFacets: { buildIds: [], sessionIds: [] },
          telemetryFields: fields,
        };
      }
      if (operation.includes("query TelemetryTimeline")) {
        const input = variables.input!;
        const items = entries.filter((entry) =>
          matchesTelemetryQuery(entry, input),
        );
        return {
          telemetryTimeline: {
            items,
            nextCursor: null,
            matchingCount: items.length,
            totalCount: entries.filter(
              (entry) =>
                input.view === "UNIFIED" || entry.entryType === input.view,
            ).length,
          },
        };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    },
  );
});

async function expand(view: TelemetryView, entry: TelemetryEntryView) {
  render(<TelemetryPage view={view} />);
  const text =
    entry.entryType === "CONSOLE" ? entry.message! : entry.eventName!;
  const cell = await screen.findByText(text, {
    exact: false,
    selector: "td span",
  });
  fireEvent.click(cell);
  await screen.findByRole("button", { name: "Delete" });
}

function metadataValue(label: string) {
  const term = screen.getByText(label, { selector: "dt" });
  const value = term.parentElement!.querySelector("dd");
  expect(value).toBeTruthy();
  return value!;
}

async function chooseFilter(target: Element) {
  fireEvent.contextMenu(target);
  const action = await screen.findByRole("menuitem", {
    name: "Filter by value",
  });
  fireEvent.click(action);
}

function queryWithFilter(field: string, value: string) {
  return request.mock.calls
    .filter(([operation]) =>
      String(operation).includes("query TelemetryTimeline"),
    )
    .map(([, variables]) => (variables as { input: TelemetryQueryInput }).input)
    .find(
      (input) =>
        input.quickFilters?.[field]?.includes(value) ||
        input.advancedFilter?.conditions.some(
          (condition) =>
            condition.field === field &&
            condition.operator === "IS" &&
            condition.value === value &&
            condition.caseSensitive === true,
        ),
    );
}

async function expectImmediateFilter(field: string, value: string) {
  await waitFor(() => expect(queryWithFilter(field, value)).toBeTruthy());
  expect(
    screen.queryByRole("heading", { name: "Advanced filters" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Collapse row" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
}

describe("expanded telemetry value menus", () => {
  test.each([
    ["CONSOLE", log, "attributes.device.model"],
    ["ANALYTICS", analytics, "defaultParameters.device.model"],
    ["UNIFIED", analytics, "defaultParameters.device.model"],
  ] as const)(
    "filters a nested parameter immediately in %s",
    async (view, entry, field) => {
      await expand(view, entry);
      await chooseFilter(screen.getByText("device.model", { selector: "dt" }));
      await expectImmediateFilter(field, "iPhone");
    },
  );

  test.each([
    ["literal.key", 'attributes["literal.key"]', "0"],
    ["enabled", "attributes.enabled", "false"],
    ["payload", "attributes.payload", '[{"a":2,"z":1}]'],
    ["empty", "attributes.empty", "{}"],
  ])(
    "filters %s using its canonical path and match representation",
    async (label, field, value) => {
      await expand("CONSOLE", log);
      await chooseFilter(screen.getByText(label, { selector: "dt" }));
      await expectImmediateFilter(field, value);
    },
  );

  test("filters additional analytics parameters by their own prefix", async () => {
    await expand("ANALYTICS", analytics);
    await chooseFilter(screen.getByText("campaign.source", { selector: "dt" }));
    await expectImmediateFilter(
      "additionalParameters.campaign.source",
      "email",
    );
  });

  test("keeps parameter copies separate from dictionary copies", async () => {
    await expand("CONSOLE", log);
    const parameter = screen.getByText("device.model", { selector: "dt" });
    fireEvent.contextMenu(parameter);
    expect(
      screen.queryByRole("menuitem", { name: "Copy JSON dictionary" }),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy device.model: value" }),
    );
    expect(copyText).toHaveBeenLastCalledWith("device.model: iPhone");

    fireEvent.contextMenu(parameter);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy value" }),
    );
    expect(copyText).toHaveBeenLastCalledWith("iPhone");

    fireEvent.contextMenu(screen.getByRole("heading", { name: "Attributes" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy JSON dictionary" }),
    );
    expect(copyText).toHaveBeenLastCalledWith(
      JSON.stringify(attributes, null, 2),
    );
    expect(screen.getByRole("button", { name: "Collapse row" })).toBeTruthy();
  });

  test.each([
    ["Time", "time", log.clientTime],
    ["Received", "receivedAt", log.receivedAt],
    ["Device IP", "deviceIp", log.deviceIp!],
    ["Build ID", "buildId", log.buildId!],
    ["Session ID", "sessionId", log.sessionId!],
    ["Level", "level", log.level!],
    ["Category", "category", log.category!],
  ])(
    "filters console metadata %s by its canonical value",
    async (label, field, value) => {
      await expand("CONSOLE", log);
      await chooseFilter(metadataValue(label));
      await expectImmediateFilter(field, value);
    },
  );

  test.each([
    ["Kind", "eventKind", analytics.eventKind!],
    ["Name", "eventName", analytics.eventName!],
    ["Screen Name", "screenName", analytics.screenName!],
  ])(
    "filters analytics metadata %s by its canonical field",
    async (label, field, value) => {
      await expand("ANALYTICS", analytics);
      await chooseFilter(metadataValue(label));
      await expectImmediateFilter(field, value);
    },
  );

  test.each([log, analytics])(
    "filters expanded session metadata in unified view for $entryType",
    async (entry) => {
      await expand("UNIFIED", entry);
      await chooseFilter(metadataValue("Session ID"));
      await expectImmediateFilter("sessionId", entry.sessionId!);
    },
  );

  test.each([
    ["CONSOLE", log, "Message", "message", log.message!],
    [
      "ANALYTICS",
      analytics,
      "Detail",
      "detail",
      "purchase_completed (Checkout)",
    ],
  ] as const)(
    "filters the expanded %s message or detail",
    async (view, entry, label, field, value) => {
      await expand(view, entry);
      const heading = screen.getByText(label, { selector: "p" });
      await chooseFilter(heading.parentElement!.querySelector("p + p")!);
      await expectImmediateFilter(field, value);
    },
  );

  test("refreshes the timeline with only matching parameter values", async () => {
    entries = [
      log,
      {
        ...log,
        id: "console-other",
        message: "Other checkout event",
        attributes: { device: { model: "Android" } },
      },
    ];
    await expand("CONSOLE", log);
    expect(screen.getByText("2 of 2")).toBeTruthy();
    await chooseFilter(screen.getByText("device.model", { selector: "dt" }));
    await expectImmediateFilter("attributes.device.model", "iPhone");
    await waitFor(() => {
      expect(screen.queryByText("Other checkout event")).toBeNull();
      expect(screen.getByText("1 of 2")).toBeTruthy();
    });
  });

  test("copies formatted metadata text while filtering timestamps by ISO value", async () => {
    await expand("CONSOLE", log);
    const time = metadataValue("Time");
    const formatted = time.textContent!;
    expect(formatted).not.toBe(log.clientTime);
    fireEvent.contextMenu(time);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy Time: value" }),
    );
    expect(copyText).toHaveBeenLastCalledWith(`Time: ${formatted}`);

    fireEvent.contextMenu(time);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy value" }),
    );
    expect(copyText).toHaveBeenLastCalledWith(formatted);

    await chooseFilter(time);
    await expectImmediateFilter("time", log.clientTime);
  });

  test("disables filtering for missing metadata", async () => {
    const missing = { ...log, sessionId: null };
    entries = [missing];
    await expand("CONSOLE", missing);
    const value = metadataValue("Session ID");
    expect(value.textContent).toBe("—");
    fireEvent.contextMenu(value);
    const filter = await screen.findByRole("menuitem", {
      name: "Filter by value",
    });
    expect(filter.getAttribute("aria-disabled")).toBe("true");
  });
});
