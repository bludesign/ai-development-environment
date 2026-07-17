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

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);
const subscriptionsMock = vi.mocked(controlPlaneSubscriptions);
const subscribe = vi.fn(() => vi.fn());

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
          agent: agent("old", "ONLINE", ["cloudflared.runTunnel"]),
          status: "UNSUPPORTED",
          jobId: null,
          error: null,
        },
      ],
    },
    aggregate,
    allAggregate: { days: [{ period: "2026-07-16" }] },
  };
}

describe("UsagePage", () => {
  beforeEach(() => {
    subscribe.mockReset();
    subscribe.mockImplementation(() => vi.fn());
    subscriptionsMock.mockReturnValue({ subscribe } as never);
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query CcusageCollection")) {
        return { ccusageCollection: collection() } as never;
      }
      if (query.includes("mutation CollectCcusage")) {
        return { collectCcusage: { id: "collection-1" } } as never;
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
    expect(screen.getAllByText("$1.26").length).toBeGreaterThan(0);

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
            variables?.range === "LAST_7_DAYS",
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
});
