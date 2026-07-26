import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { SidebarStatusFooter } from "./sidebar-status";

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

const sidebarStatus = {
  usageToday: { totalCost: 1.25, collectedAt: null },
  activity: { plans: 0, sessions: 0, builds: 0, workflows: 0 },
  diskSpace: {
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
        lastReportedAt: "2026-07-25T23:42:12.000Z",
        lastError: null,
        warnings: [],
        volumes: [
          {
            id: "main",
            totalBytes: 500 * 1024 ** 3,
            freeBytes: 100 * 1024 ** 3,
            roles: ["MAIN", "BASE_REPO", "DERIVED_DATA"],
            paths: [
              "/",
              "/Users/example/Workspaces",
              "/Users/example/Library/Developer/Xcode/DerivedData",
            ],
            status: "PRESSURE",
            effectiveThresholdBytes: 10 * 1024 ** 3,
            monitored: true,
          },
        ],
      },
    ],
  },
};

describe("SidebarStatusFooter", () => {
  beforeEach(() => {
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query SidebarStatus")) {
        return {
          sidebarStatus,
          derivedDataDeletionHistory: { items: [] },
        } as never;
      }
      if (operation.includes("SidebarPressureMode")) {
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

  test("links to Build Data and renders active pressure controls in yellow", async () => {
    render(<SidebarStatusFooter />);

    await screen.findByText("$1.25");
    fireEvent.click(screen.getByRole("button", { name: /Free Disk Space/ }));

    expect(
      screen
        .getByRole("link", { name: "Free Disk Space" })
        .getAttribute("href"),
    ).toBe("/build-data");
    for (const badge of screen.getAllByText("Pressure")) {
      expect(badge.className).toContain("bg-amber-500/10");
    }

    const pressureMode = screen.getByRole("button", {
      name: "Pressure mode",
    });
    expect(pressureMode.getAttribute("aria-pressed")).toBe("true");
    expect(pressureMode.className).toContain("bg-amber-500/10");
    expect(pressureMode.nextElementSibling?.textContent).toBe("Pressure");
    expect(
      screen.getByText("Main disk, Base repository, Derived Data"),
    ).toBeTruthy();

    fireEvent.click(pressureMode);
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("SidebarPressureMode") &&
            JSON.stringify(variables) ===
              JSON.stringify({ agentId: "agent-1", enabled: false }),
        ),
      ).toBe(true),
    );
  });

  test("fills multi-agent circles with used disk space", async () => {
    request.mockImplementation(async (query) => {
      if (!String(query).includes("query SidebarStatus")) {
        throw new Error(`Unexpected operation: ${String(query)}`);
      }
      return {
        sidebarStatus: {
          ...sidebarStatus,
          diskSpace: {
            ...sidebarStatus.diskSpace,
            agents: [
              sidebarStatus.diskSpace.agents[0],
              {
                ...sidebarStatus.diskSpace.agents[0],
                agent: {
                  ...sidebarStatus.diskSpace.agents[0].agent,
                  id: "agent-2",
                  name: "Builder 2",
                },
              },
            ],
          },
        },
        derivedDataDeletionHistory: { items: [] },
      } as never;
    });

    render(<SidebarStatusFooter />);

    const circle = await screen.findByLabelText(
      "Builder · Derived Data: 100 GiB free",
    );
    expect(circle.style.background).toContain("80%");
  });
});
