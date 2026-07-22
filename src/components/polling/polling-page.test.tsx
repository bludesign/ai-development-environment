import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { PollingPage } from "./polling-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const operation = {
  kind: "AGENT_HEARTBEAT",
  status: "HEALTHY",
  enabled: true,
  cadenceSeconds: 30,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastSucceededAt: null,
  nextScheduledAt: null,
  durationMs: null,
  lastError: null,
};

describe("PollingPage", () => {
  beforeEach(() => {
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockResolvedValue({
      pollingOperations: [
        {
          ...operation,
          id: "server-operation",
          runtime: "SERVER",
          details: { source: "database" },
        },
        {
          ...operation,
          id: "agent-operation",
          runtime: "AGENT",
          details: {
            agentId: "agent-1",
            agentName: "Builder",
            queuedJobs: 2,
          },
        },
      ],
    } as never);
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("shows the linked agent in its own column and omits agent metadata from details", async () => {
    const { container } = render(<PollingPage />);

    const agentLink = await screen.findByRole("link", { name: "Builder" });
    expect(agentLink.getAttribute("href")).toBe("/agents/agent-1");

    const agentTable = agentLink.closest("table");
    expect(agentTable).not.toBeNull();
    expect(
      within(agentTable as HTMLTableElement).getByRole("columnheader", {
        name: "Agent",
      }),
    ).toBeDefined();
    expect(
      within(agentTable as HTMLTableElement).getByText("queuedJobs: 2"),
    ).toBeDefined();
    expect(container.textContent).not.toContain("agentId:");
    expect(container.textContent).not.toContain("agentName:");
    expect(screen.getAllByRole("columnheader", { name: "Agent" })).toHaveLength(
      1,
    );
  });
});
