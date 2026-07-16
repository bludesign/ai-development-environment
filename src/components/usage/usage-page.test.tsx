import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Agent, AgentJob } from "@/components/agents/types";
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
    connectionStatus,
    ipAddress: null,
    lastSeenAt: new Date(0).toISOString(),
    disconnectedAt: null,
    createdAt: new Date(0).toISOString(),
  };
}

const report = {
  daily: [
    {
      agent: "all",
      period: "2026-07-16",
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      totalTokens: 100,
      totalCost: 1.256,
      metadata: { agents: ["codex"] },
      modelsUsed: ["gpt-5"],
      modelBreakdowns: [
        {
          modelName: "gpt-5",
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationTokens: 30,
          cacheReadTokens: 40,
          cost: 1.256,
        },
      ],
    },
  ],
  totals: {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    totalTokens: 100,
    totalCost: 1.256,
  },
};

function job(
  agentId: string,
  status: AgentJob["status"],
  result: unknown = null,
): AgentJob {
  return {
    id: `job-${agentId}`,
    agentId,
    kind: "ccusage.report",
    payload: {},
    status,
    error: status === "FAILED" ? "ccusage executable not found" : null,
    result,
    timeoutSeconds: 120,
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    finishedAt: status === "QUEUED" ? null : new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("UsagePage", () => {
  beforeEach(() => {
    subscribe.mockReset();
    subscribe.mockImplementation(() => vi.fn());
    subscriptionsMock.mockReturnValue({ subscribe } as never);
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("UsageAgents")) {
        return {
          agents: [
            agent("a", "ONLINE"),
            agent("b", "ONLINE"),
            agent("offline", "OFFLINE"),
            agent("old", "ONLINE", ["cloudflared.runTunnel"]),
          ],
        } as never;
      }
      if (query.includes("CollectUsage")) {
        const agentId = (variables?.input as { agentId: string }).agentId;
        return { createAgentJob: job(agentId, "QUEUED") } as never;
      }
      if (query.includes("query UsageJob")) {
        const agentId = String(variables?.id).replace("job-", "");
        return {
          agentJob:
            agentId === "a"
              ? job("a", "SUCCEEDED", {
                  exitCode: 0,
                  signal: null,
                  timedOut: false,
                  cancelled: false,
                  report,
                })
              : job("b", "FAILED"),
        } as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });
  });

  afterEach(() => {
    cleanup();
    requestMock.mockReset();
    subscriptionsMock.mockReset();
  });

  test("collects compatible online agents, keeps partial results, and expands the hierarchy", async () => {
    render(<UsagePage />);

    expect(
      await screen.findByText("1 of 2 compatible agents reported"),
    ).toBeDefined();
    expect(screen.getByText(/Offline: Agent OFFLINE/)).toBeDefined();
    expect(screen.getByText(/Update required: Agent OLD/)).toBeDefined();
    expect(screen.getByText(/Failed: Agent B/)).toBeDefined();
    expect(screen.getByText("Daily cost by model")).toBeDefined();
    expect(screen.getAllByText("$1.26").length).toBeGreaterThan(0);
    expect(
      screen
        .getByRole("button", { name: "All data" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(
      screen
        .getByRole("button", { name: "7 days" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    const collectionCalls = requestMock.mock.calls.filter(([query]) =>
      String(query).includes("CollectUsage"),
    );
    expect(collectionCalls).toHaveLength(2);
    expect(
      collectionCalls.map(
        ([, variables]) => (variables?.input as { agentId: string }).agentId,
      ),
    ).toEqual(expect.arrayContaining(["a", "b"]));

    const dateButton = screen.getByRole("button", {
      name: "Show models for 2026-07-16",
    });
    expect(dateButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(dateButton);
    expect(dateButton.getAttribute("aria-expanded")).toBe("true");

    const modelButton = screen.getByRole("button", {
      name: "Show agents using gpt-5",
    });
    fireEvent.click(modelButton);
    expect(screen.getByText("Agent A")).toBeDefined();
    expect(screen.getByText("a.local · codex")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
    await waitFor(() => {
      expect(
        requestMock.mock.calls.filter(([query]) =>
          String(query).includes("CollectUsage"),
        ),
      ).toHaveLength(4);
    });
  });
});
