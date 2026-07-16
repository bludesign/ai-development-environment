import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { AgentDetail } from "./agent-detail";
import type { AgentJob } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);
const subscriptionsMock = vi.mocked(controlPlaneSubscriptions);

Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: () => undefined,
});

afterEach(() => {
  cleanup();
  requestMock.mockReset();
  subscriptionsMock.mockReset();
});

describe("AgentDetail", () => {
  test("keeps job-history items keyboard-focusable and selects another job", async () => {
    const createdAt = new Date(0).toISOString();
    const jobs: AgentJob[] = [
      {
        id: "job-1",
        agentId: "agent-1",
        kind: "cloudflared.first",
        payload: {},
        status: "SUCCEEDED",
        error: null,
        result: null,
        timeoutSeconds: 60,
        createdAt,
        startedAt: createdAt,
        finishedAt: createdAt,
        updatedAt: createdAt,
      },
      {
        id: "job-2",
        agentId: "agent-1",
        kind: "cloudflared.second",
        payload: {},
        status: "SUCCEEDED",
        error: null,
        result: null,
        timeoutSeconds: 60,
        createdAt,
        startedAt: createdAt,
        finishedAt: createdAt,
        updatedAt: createdAt,
      },
    ];
    subscriptionsMock.mockReturnValue({
      subscribe: vi.fn(() => vi.fn()),
    } as never);
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("query AgentDetail")) {
        return {
          agent: {
            id: "agent-1",
            name: "Development Mac",
            hostname: "dev-mac.local",
            version: "1.0.0",
            osVersion: "macOS",
            architecture: "arm64",
            capabilities: ["cloudflared.runTunnel"],
            connectionStatus: "ONLINE",
            ipAddress: null,
            lastSeenAt: createdAt,
            disconnectedAt: null,
            createdAt,
          },
          agentJobs: jobs,
        } as never;
      }
      if (query.includes("query Job")) {
        const job = jobs.find((item) => item.id === variables?.id) ?? null;
        return { agentJob: job, agentJobLogs: [] } as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<AgentDetail agentId="agent-1" />);
    const secondJob = await screen.findByRole("button", {
      name: /cloudflared\.second/i,
    });
    secondJob.focus();
    expect(document.activeElement).toBe(secondJob);
    fireEvent.click(secondJob);

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("query Job"),
        { id: "job-2" },
      ),
    );
  });
});
