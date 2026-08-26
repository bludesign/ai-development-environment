import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Agent } from "@/components/agents/types";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { UsagePage } from "./usage-page";
import { usagePeriodForDate } from "./aggregate-usage";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);
const subscriptionsMock = vi.mocked(controlPlaneSubscriptions);
const subscribe = vi.fn(() => vi.fn());

// Recharts' ResponsiveContainer measures itself with getBoundingClientRect, which is
// always 0x0 in jsdom, and then warns that the chart has no size. Reporting a fixed box
// from the observer on observe() gives the chart real dimensions instead.
class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: { width: 800, height: 400 },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

function agent(
  id: string,
  connectionStatus: Agent["connectionStatus"],
  capabilities = ["ccusage.report"],
): Agent {
  return {
    id,
    name: `Agent ${id.toUpperCase()}`,
    hostname: `${id}.local`,
    version: "0.1.0",
    osVersion: "macOS",
    architecture: "arm64",
    capabilities,
    baseRepoDirectory: null,
    connectionStatus,
    ipAddress: null,
    lastSeenAt: new Date(0).toISOString(),
    disconnectedAt: null,
    createdAt: new Date(0).toISOString(),
  };
}

const metrics = {
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationTokens: 30,
  cacheReadTokens: 40,
  totalTokens: 100,
  totalCost: 1.256,
};

const aggregate = {
  days: [
    {
      ...metrics,
      period: "2026-07-16",
      sources: ["codex"],
      models: [
        {
          ...metrics,
          modelName: "gpt-5",
          unattributed: false,
          agents: [
            {
              ...metrics,
              agentId: "a",
              agentName: "Agent A",
              hostname: "a.local",
              sources: ["codex"],
            },
          ],
        },
      ],
    },
  ],
  totals: metrics,
};

function collection(status: "COLLECTING" | "COMPLETED" = "COMPLETED") {
  return {
    id: "collection-1",
    status,
    createdAt: new Date(0).toISOString(),
    deadlineAt: new Date(150_000).toISOString(),
    finishedAt: status === "COMPLETED" ? new Date(1).toISOString() : null,
    progress: {
      eligibleCount: 2,
      finishedCount: status === "COMPLETED" ? 2 : 1,
      successfulCount: 1,
      agents: [
        {
          agent: agent("a", "ONLINE"),
          status: "SUCCEEDED",
          jobId: "job-a",
          error: null,
        },
        {
          agent: agent("b", "ONLINE"),
          status: status === "COMPLETED" ? "FAILED" : "RUNNING",
          jobId: "job-b",
          error: status === "COMPLETED" ? "ccusage executable not found" : null,
        },
        {
          agent: agent("offline", "OFFLINE"),
          status: "OFFLINE",
          jobId: null,
          error: null,
        },
        {
          agent: agent("old", "ONLINE", ["command.run"]),
          status: "UNSUPPORTED",
          jobId: null,
          error: null,
        },
      ],
    },
    hasStoredHistory: true,
    aggregate,
    allAggregate: { days: [{ period: "2026-07-16" }] },
    spendPeaks: {
      last7Days: {
        startDate: "2026-07-10",
        endDate: "2026-07-16",
        totalCost: 1.256,
      },
      last30Days: {
        startDate: "2026-06-17",
        endDate: "2026-07-16",
        totalCost: 4.5,
      },
    },
  };
}

function collectionWithTwoSuccessfulAgents() {
  const result = structuredClone(collection());
  const secondAgent = result.progress.agents[1];
  if (!secondAgent) throw new Error("Expected a second agent");
  secondAgent.status = "SUCCEEDED";
  secondAgent.error = null;
  result.progress.successfulCount = 2;

  const secondMetrics = {
    inputTokens: 5,
    outputTokens: 10,
    cacheCreationTokens: 15,
    cacheReadTokens: 20,
    totalTokens: 50,
    totalCost: 0.5,
  };
  const combinedMetrics = {
    inputTokens: 15,
    outputTokens: 30,
    cacheCreationTokens: 45,
    cacheReadTokens: 60,
    totalTokens: 150,
    totalCost: 1.756,
  };
  const day = result.aggregate.days[0];
  const model = day?.models[0];
  if (!day || !model) throw new Error("Expected aggregate usage");
  model.agents.push({
    ...secondMetrics,
    agentId: "b",
    agentName: "Agent B",
    hostname: "b.local",
    sources: ["claude"],
  });
  Object.assign(day, combinedMetrics);
  Object.assign(model, combinedMetrics);
  Object.assign(result.aggregate.totals, combinedMetrics);
  return result;
}

describe("UsagePage", () => {
  beforeEach(() => {
    global.ResizeObserver = ResizeObserverMock;
    Element.prototype.scrollIntoView = vi.fn();
    subscribe.mockReset();
    subscribe.mockImplementation(() => vi.fn());
    subscriptionsMock.mockReturnValue({ subscribe } as never);
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query CcusageCollection")) {
        return { ccusageCollection: collection() } as never;
      }
      if (query.includes("mutation CollectCcusage")) {
        return { collectCcusage: collection() } as never;
      }
      if (query.includes("mutation ClearCcusageHistory")) {
        return { clearCcusageHistory: 1 } as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    requestMock.mockReset();
    subscriptionsMock.mockReset();
  });

  test("renders backend progress and aggregate without recollecting on range changes", async () => {
    render(<UsagePage />);

    expect(
      await screen.findByText("1 of 2 compatible agents reported"),
    ).toBeDefined();
    expect(screen.getByText(/Offline: Agent OFFLINE/)).toBeDefined();
    expect(screen.getByText(/Update required: Agent OLD/)).toBeDefined();
    expect(screen.getByText(/Failed: Agent B/)).toBeDefined();
    expect(screen.getByText("Daily cost by model")).toBeDefined();
    expect(
      screen.getByRole("tab", { name: "30 days" }).getAttribute("data-active"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: /Select usage end date, currently/,
      }),
    ).toBeDefined();
    expect(screen.getAllByText("$1.26").length).toBeGreaterThan(0);
    expect(screen.getByText("Spend records")).toBeDefined();
    expect(screen.getByText("Highest 7-day spend")).toBeDefined();
    expect(screen.getByText("Highest 30-day spend")).toBeDefined();
    expect(
      screen.getByRole("group", {
        name: /Highest 7-day spend: \$1\.26, from/,
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("combobox", { name: "Filter usage by agent" }),
    ).toBeNull();

    const dateButton = screen.getByRole("button", {
      name: "Show models for 2026-07-16",
    });
    fireEvent.click(dateButton);
    fireEvent.click(
      screen.getByRole("button", { name: "Show agents using gpt-5" }),
    );
    expect(screen.getByText("Agent A")).toBeDefined();
    expect(screen.getByText("a.local · codex")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("query CcusageCollection") &&
            variables?.range === "LAST_7_DAYS" &&
            variables?.endDate === usagePeriodForDate(new Date()),
        ),
      ).toBe(true);
    });
    expect(
      requestMock.mock.calls.filter(([query]) =>
        String(query).includes("mutation CollectCcusage"),
      ),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
    await waitFor(() => {
      expect(
        requestMock.mock.calls.filter(([query]) =>
          String(query).includes("mutation CollectCcusage"),
        ),
      ).toHaveLength(2);
    });
  });

  test("shows the bounded date selector, disables future dates, and preserves its value", async () => {
    render(<UsagePage />);

    const picker = await screen.findByRole("button", {
      name: /Select usage end date, currently/,
    });
    fireEvent.click(picker);
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const futureDay = document.querySelector(
      `[data-day="${tomorrow.toLocaleDateString()}"]`,
    );
    expect(futureDay?.hasAttribute("disabled")).toBe(true);

    const yesterday = new Date();
    yesterday.setHours(0, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayButton = document.querySelector(
      `[data-day="${yesterday.toLocaleDateString()}"]`,
    );
    expect(yesterdayButton).not.toBeNull();
    fireEvent.click(yesterdayButton!);
    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("query CcusageCollection") &&
            variables?.endDate === usagePeriodForDate(yesterday),
        ),
      ).toBe(true),
    );
    expect(
      requestMock.mock.calls.filter(([query]) =>
        String(query).includes("mutation CollectCcusage"),
      ),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: "All data" }));
    expect(
      screen.queryByRole("button", { name: /Select usage end date/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    expect(
      screen.getByRole("button", { name: /Select usage end date, currently/ }),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("query CcusageCollection") &&
            variables?.range === "LAST_7_DAYS" &&
            variables?.endDate === usagePeriodForDate(yesterday),
        ),
      ).toBe(true),
    );
  });

  test("searches and filters usage when multiple agents report", async () => {
    const result = collectionWithTwoSuccessfulAgents();
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("query CcusageCollection")) {
        if (variables?.peakAgentId === "b") {
          result.spendPeaks.last7Days!.totalCost = 0.5;
          result.spendPeaks.last30Days!.totalCost = 0.5;
        }
        return { ccusageCollection: result } as never;
      }
      if (query.includes("mutation CollectCcusage")) {
        return { collectCcusage: result } as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<UsagePage />);

    const filter = await screen.findByRole("combobox", {
      name: "Filter usage by agent",
    });
    expect(filter.textContent).toContain("All agents");
    fireEvent.click(filter);
    const search = screen.getByRole("combobox", { name: "Search agents…" });
    fireEvent.change(search, { target: { value: "b.local" } });
    expect(
      await screen.findByRole("option", { name: "Agent B, b.local" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("option", { name: "Agent A, a.local" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Agent B, b.local" }));

    await waitFor(() => expect(filter.textContent).toContain("Agent B"));
    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("query CcusageCollection") &&
            variables?.peakAgentId === "b",
        ),
      ).toBe(true),
    );
    expect(
      screen.getByText("Grand total").closest("tr")?.textContent,
    ).toContain("$0.50");

    fireEvent.click(
      screen.getByRole("button", { name: "Show models for 2026-07-16" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show agents using gpt-5" }),
    );
    expect(screen.queryByText("Agent A")).toBeNull();
    expect(screen.getAllByText("Agent B").length).toBeGreaterThan(0);
    expect(screen.getByText("b.local · claude")).toBeDefined();
    expect(
      requestMock.mock.calls.filter(([query]) =>
        String(query).includes("mutation CollectCcusage"),
      ),
    ).toHaveLength(1);
  });

  test("refreshes spend records for the active model without recollecting", async () => {
    render(<UsagePage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Show only gpt-5" }),
    );
    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("query CcusageCollection") &&
            variables?.peakModelName === "gpt-5",
        ),
      ).toBe(true),
    );
    expect(
      requestMock.mock.calls.filter(([query]) =>
        String(query).includes("mutation CollectCcusage"),
      ),
    ).toHaveLength(1);
  });

  test("uses query reconciliation when the progress subscription is silent", async () => {
    vi.useFakeTimers();
    let reads = 0;
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query CcusageCollection")) {
        reads += 1;
        return {
          ccusageCollection: reads === 1 ? null : collection("COLLECTING"),
        } as never;
      }
      if (query.includes("mutation CollectCcusage")) {
        return new Promise(() => undefined) as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<UsagePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText("Daily cost by model")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("Daily cost by model")).toBeDefined();
    expect(screen.getByText("1 of 2 compatible agents reported")).toBeDefined();
  });

  test("switches between history and live data without recollecting", async () => {
    render(<UsagePage />);

    const toggle = await screen.findByRole("button", {
      name: "Include stored usage history",
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("query CcusageCollection") &&
            variables?.includeHistory === false,
        ),
      ).toBe(true),
    );
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(
      requestMock.mock.calls.filter(([query]) =>
        String(query).includes("mutation CollectCcusage"),
      ),
    ).toHaveLength(1);
  });

  test("ignores a collect response captured before the history filter changed", async () => {
    let resolveCollect:
      | ((value: { collectCcusage: ReturnType<typeof collection> }) => void)
      | undefined;
    const pendingCollect = new Promise<{
      collectCcusage: ReturnType<typeof collection>;
    }>((resolve) => {
      resolveCollect = resolve;
    });
    const liveCollection = structuredClone(collection());
    liveCollection.aggregate.totals.totalCost = 0.5;
    liveCollection.aggregate.days[0]!.totalCost = 0.5;
    liveCollection.aggregate.days[0]!.models[0]!.totalCost = 0.5;
    liveCollection.aggregate.days[0]!.models[0]!.agents[0]!.totalCost = 0.5;
    liveCollection.spendPeaks.last7Days!.totalCost = 0.5;
    liveCollection.spendPeaks.last30Days!.totalCost = 0.5;
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("query CcusageCollection")) {
        return {
          ccusageCollection:
            variables?.includeHistory === false ? liveCollection : collection(),
        } as never;
      }
      if (query.includes("mutation CollectCcusage")) {
        return pendingCollect as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<UsagePage />);
    const toggle = await screen.findByRole("button", {
      name: "Include stored usage history",
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getAllByText("$0.50").length).toBeGreaterThan(0),
    );

    await act(async () => {
      resolveCollect?.({ collectCcusage: collection() });
      await pendingCollect;
    });

    expect(screen.getAllByText("$0.50").length).toBeGreaterThan(0);
    expect(screen.queryByText("$1.26")).toBeNull();
  });

  test("confirms before clearing all stored history", async () => {
    render(<UsagePage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Clear history" }),
    );
    expect(screen.getByText("Clear all usage history?")).toBeDefined();
    const actions = screen.getAllByRole("button", { name: "Clear history" });
    fireEvent.click(actions.at(-1)!);

    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(([query]) =>
          String(query).includes("mutation ClearCcusageHistory"),
        ),
      ).toBe(true),
    );
  });

  test("renders stored aggregate while current agents are still collecting", async () => {
    const collecting = collection("COLLECTING");
    collecting.progress.successfulCount = 0;
    collecting.progress.agents[0]!.status = "RUNNING";
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query CcusageCollection")) {
        return { ccusageCollection: collecting } as never;
      }
      if (query.includes("mutation CollectCcusage")) {
        return { collectCcusage: collecting } as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<UsagePage />);

    expect(await screen.findByText("Daily cost by model")).toBeDefined();
    expect(screen.getByText("0 of 2 compatible agents reported")).toBeDefined();
  });
});
