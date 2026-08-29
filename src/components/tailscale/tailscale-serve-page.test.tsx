import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { TailscaleServePage } from "./tailscale-serve-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

vi.mock("@/components/workflows/workflow-resource-panel", () => ({
  WorkflowResourcePanel: () => null,
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const route = {
  protocol: "HTTPS",
  listenPort: 443,
  mountPath: "/dashboard",
  destination: { protocol: "HTTP", port: 3000, path: "" },
  funnel: false,
  appCapabilities: [],
  proxyProtocol: "NONE",
} as const;

const studioAgent = {
  id: "agent-studio",
  name: "Studio Mac",
  hostname: "studio.local",
  lastSeenAt: "2026-08-29T12:00:00.000Z",
  disconnectedAt: null,
};

const overview = {
  updatedAt: "2026-08-29T12:00:00.000Z",
  agents: [
    {
      agent: studioAgent,
      supported: true,
      dnsHostname: "studio.example.ts.net",
      ipv4: ["100.64.0.10"],
      ipv6: ["fd7a:115c:a1e0::10"],
      backendState: "Running",
      observedRoutes: [route],
      lastInspectedAt: "2026-08-29T12:00:00.000Z",
      error: null,
    },
    {
      agent: {
        id: "agent-old",
        name: "Old Linux",
        hostname: "old.local",
        lastSeenAt: null,
        disconnectedAt: "2026-08-28T12:00:00.000Z",
      },
      supported: false,
      dnsHostname: null,
      ipv4: [],
      ipv6: [],
      backendState: "Unknown",
      observedRoutes: [],
      lastInspectedAt: null,
      error: null,
    },
  ],
  templates: [
    {
      id: "template-dashboard",
      name: "Dashboard",
      route,
      fingerprint: "fingerprint",
      revision: 3,
      lifecycle: "ACTIVE",
      origin: "USER",
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:00:00.000Z",
      assignments: [
        {
          agent: studioAgent,
          desiredEnabled: true,
          observedEnabled: true,
          observedFingerprint: "fingerprint",
          revision: 3,
          status: "SUCCEEDED",
          lastJobId: "job-1",
          lastError: null,
          lastObservedAt: "2026-08-29T12:00:00.000Z",
        },
      ],
    },
  ],
};

describe("TailscaleServePage", () => {
  beforeEach(() => {
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockImplementation(async (query) => {
      if (String(query).includes("mutation InspectTailscaleServe")) {
        return {
          inspectTailscaleServe: {
            id: "operation-1",
            kind: "INSPECT",
            status: "QUEUED",
            templateId: null,
            createdAt: "2026-08-29T12:00:00.000Z",
            finishedAt: null,
            agents: [],
          },
        } as never;
      }
      return { tailscaleServeOverview: overview } as never;
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("renders fleet identity, unsupported agents, and desired versus observed state", async () => {
    render(<TailscaleServePage />);

    expect(await screen.findAllByText("Studio Mac")).toHaveLength(2);
    expect(screen.getByText("studio.example.ts.net")).toBeDefined();
    expect(screen.getByText("100.64.0.10")).toBeDefined();
    expect(screen.getByText("fd7a:115c:a1e0::10")).toBeDefined();
    expect(screen.getByText("Old Linux")).toBeDefined();
    expect(screen.getByText("Online")).toBeDefined();
    expect(screen.getByText("Offline")).toBeDefined();
    expect(screen.getByText("Unsupported")).toBeDefined();
    expect(screen.getByText("Dashboard")).toBeDefined();
    expect(screen.getByText("Observed on")).toBeDefined();
    expect(
      screen
        .getByRole("checkbox", { name: "Toggle Dashboard on Studio Mac" })
        .getAttribute("data-state"),
    ).toBe("checked");
  });

  test("queues a manual fleet inspection and refreshes the overview", async () => {
    render(<TailscaleServePage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Inspect agents" }),
    );

    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(String(request.mock.calls[1]?.[0])).toContain(
      "mutation InspectTailscaleServe",
    );
  });
});
