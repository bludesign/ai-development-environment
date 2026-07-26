import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { DiskSpaceMonitor } from "./disk-space-monitor";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const reportedAt = "2026-07-25T23:42:12.000Z";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderMonitor() {
  return render(
    <TooltipProvider>
      <DiskSpaceMonitor />
    </TooltipProvider>,
  );
}

const overview = {
  settings: {
    normalThresholdGiB: 40,
    pressureThresholdGiB: 10,
    pollIntervalSeconds: 60,
    staleAfterSeconds: 180,
  },
  agents: [
    {
      agent: {
        id: "agent-1",
        name: "Builder",
        hostname: "builder.local",
        connectionStatus: "ONLINE",
      },
      enabled: true,
      status: "PRESSURE",
      pressureMode: "MANUAL",
      manualPressureMode: true,
      automaticPressureMode: false,
      lastReportedAt: reportedAt,
      lastError: null,
      warnings: [],
      volumes: [
        {
          id: "main",
          totalBytes: 500 * 1024 ** 3,
          freeBytes: 100 * 1024 ** 3,
          roles: ["MAIN", "DERIVED_DATA"],
          paths: ["/"],
          status: "PRESSURE",
          effectiveThresholdBytes: 10 * 1024 ** 3,
          monitored: true,
        },
      ],
    },
  ],
};

describe("DiskSpaceMonitor", () => {
  beforeEach(() => {
    global.ResizeObserver = ResizeObserverMock;
    Object.defineProperties(HTMLElement.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      releasePointerCapture: { configurable: true, value: () => undefined },
      setPointerCapture: { configurable: true, value: () => undefined },
    });
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query DiskSpaceOverview")) {
        return { diskSpaceOverview: overview } as never;
      }
      if (operation.includes("UpdateDiskSpaceSettings")) {
        return {
          updateDiskSpaceSettings: overview.settings,
        } as never;
      }
      if (operation.includes("SetAgentDiskSpaceMonitoring")) {
        return { setAgentDiskSpaceMonitoring: { enabled: false } } as never;
      }
      if (operation.includes("SetAgentDiskSpacePressureMode")) {
        return {
          setAgentDiskSpacePressureMode: { manualPressureMode: false },
        } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("puts threshold settings in a header dialog and uses the shared date renderer", async () => {
    renderMonitor();

    await screen.findByText("Builder");
    expect(screen.queryByLabelText("Cleanup threshold (GiB)")).toBeNull();

    const settingsButton = screen.getByRole("button", { name: "Settings" });
    const cardHeader = settingsButton.closest('[data-slot="card-header"]');
    expect(cardHeader).not.toBeNull();
    expect(cardHeader!.querySelector("svg")).toBeNull();

    const observed = screen.getByText(/Observed/);
    expect(observed.querySelector("time")?.getAttribute("datetime")).toBe(
      reportedAt,
    );

    fireEvent.click(settingsButton);
    const normal = screen.getByLabelText("Cleanup threshold (GiB)");
    const pressure = screen.getByLabelText("Pressure threshold (GiB)");
    fireEvent.change(normal, { target: { value: "50" } });
    fireEvent.change(pressure, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save thresholds" }));

    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("UpdateDiskSpaceSettings") &&
            JSON.stringify(variables) ===
              JSON.stringify({
                input: {
                  normalThresholdGiB: 50,
                  pressureThresholdGiB: 12,
                },
              }),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Cleanup threshold (GiB)")).toBeNull(),
    );
  });

  test("renders the active monitor green and pressure controls yellow", async () => {
    renderMonitor();

    const monitor = await screen.findByRole("button", {
      name: "Monitor agent",
    });
    const pressure = screen.getByRole("button", { name: "Pressure mode" });

    expect(monitor.getAttribute("aria-pressed")).toBe("true");
    expect(pressure.getAttribute("aria-pressed")).toBe("true");
    expect(monitor.className).toContain("bg-emerald-500/10");
    expect(pressure.className).toContain("bg-amber-500/10");

    expect(screen.getByText("Pressure").className).toContain("bg-amber-500/10");
    expect(screen.getAllByText("Pressure")).toHaveLength(1);
    expect(screen.getByText("Manual pressure").className).toContain(
      "bg-amber-500/10",
    );

    const volume = screen
      .getByRole("progressbar")
      .closest<HTMLElement>('[data-slot="tooltip-trigger"]');
    expect(volume).not.toBeNull();
    fireEvent.focus(volume!);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Pressure",
    );

    fireEvent.click(monitor);
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("SetAgentDiskSpaceMonitoring") &&
            JSON.stringify(variables) ===
              JSON.stringify({ agentId: "agent-1", enabled: false }),
        ),
      ).toBe(true),
    );

    fireEvent.click(pressure);
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("SetAgentDiskSpacePressureMode") &&
            JSON.stringify(variables) ===
              JSON.stringify({ agentId: "agent-1", enabled: false }),
        ),
      ).toBe(true),
    );
  });
});
