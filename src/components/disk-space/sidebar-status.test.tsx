import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  onControlPlaneRecovery,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";

import { SidebarStatusFooter } from "./sidebar-status";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
  onControlPlaneMutation: vi.fn(() => vi.fn()),
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
let integrationState: {
  github: { configured: boolean };
  gitlab: { configured: boolean };
};
let providerActivity: {
  pullRequests: number | null;
  actions: number | null;
  mergeRequests: number | null;
  pipelines: number | null;
};

/** jsdom ships no `matchMedia`, and the sidebar asks it for the viewport. */
function setViewportWidth(width: number) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: width < 768,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

/** Reports the mobile sheet's state, and opens it, from inside the provider. */
function SidebarProbe() {
  const { openMobile, setOpenMobile } = useSidebar();

  return (
    <button onClick={() => setOpenMobile(true)} type="button">
      {openMobile ? "sheet open" : "sheet closed"}
    </button>
  );
}

function renderFooter() {
  return render(
    <SidebarProvider defaultOpen>
      <SidebarProbe />
      <SidebarStatusFooter />
    </SidebarProvider>,
  );
}

const sidebarStatus = {
  usageToday: { totalCost: 1.25, collectedAt: null },
  activity: { plans: 1, sessions: 2, builds: 3, workflows: 4, commands: 5 },
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
    setViewportWidth(1280);
    integrationState = {
      github: { configured: false },
      gitlab: { configured: false },
    };
    providerActivity = {
      pullRequests: 12,
      actions: 6,
      mergeRequests: 8,
      pipelines: 3,
    };
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query SidebarStatus")) {
        return {
          sidebarStatus: {
            ...sidebarStatus,
            activity: { ...sidebarStatus.activity, ...providerActivity },
            diskSummary: sidebarStatus.diskSpace,
          },
          sourceControlIntegrationState: integrationState,
          derivedDataDeletionHistory: { items: [] },
        } as never;
      }
      if (operation.includes("query SidebarDiskDetails"))
        return {
          diskSpaceOverview: sidebarStatus.diskSpace,
          derivedDataDeletionHistory: { items: [] },
        } as never;
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
    renderFooter();

    await screen.findByText("$1.25");
    fireEvent.click(screen.getByRole("button", { name: /Free Disk Space/ }));

    expect(
      screen
        .getByRole("link", { name: "Free Disk Space" })
        .getAttribute("href"),
    ).toBe("/system/build-data");
    for (const badge of screen.getAllByText("Pressure")) {
      expect(badge.className).toContain("bg-amber-500/10");
    }

    const pressureMode = await screen.findByRole("button", {
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

  test("leads the activity grid with Action Center items", async () => {
    renderFooter();

    await screen.findByText("$1.25");
    const activity = [
      ["Actions", "/dashboard/action-center"],
      ["Workflows", "/dashboard/workflows"],
      ["Plans", "/ai/plans"],
      ["Sessions", "/ai/sessions"],
      ["Builds", "/dashboard/builds"],
    ];
    for (const [label, href] of activity) {
      const link = screen.getByRole("link", { name: new RegExp(label) });
      expect(link.getAttribute("href")).toBe(href);
    }
    // Without an ActionCenterProvider the footer falls back to zero items.
    expect(
      screen.getByRole("link", { name: /^Actions/ }).textContent,
    ).toContain("0");
    expect(
      screen.getByRole("link", { name: /Commands/ }).getAttribute("href"),
    ).toBe("/dashboard/commands");
    expect(
      screen.getByRole("link", { name: /Commands/ }).textContent,
    ).toContain("5");
  });

  test.each([
    { name: "GitHub only", github: true, gitlab: false },
    { name: "GitLab only", github: false, gitlab: true },
    { name: "both providers", github: true, gitlab: true },
    { name: "neither provider", github: false, gitlab: false },
  ])("shows provider activity for $name", async ({ github, gitlab }) => {
    integrationState = {
      github: { configured: github },
      gitlab: { configured: gitlab },
    };
    renderFooter();

    await screen.findByText("$1.25");
    const counters = [
      ["Pull Reqs", "/github/pull-requests", "12", github],
      ["Actions", "/github/actions", "6", github],
      ["Merge Reqs", "/gitlab/merge-requests", "8", gitlab],
      ["Pipelines", "/gitlab/pipelines", "3", gitlab],
    ] as const;
    for (const [label, href, count, visible] of counters) {
      const link = screen
        .queryAllByRole("link", { name: new RegExp(`^${label}`) })
        .find((candidate) => candidate.getAttribute("href") === href);
      if (visible) {
        expect(link?.getAttribute("href")).toBe(href);
        expect(within(link!).getByText(count)).toBeDefined();
      } else {
        expect(link).toBeUndefined();
      }
    }
    expect(
      request.mock.calls.some(
        ([query]) =>
          query.includes("pullRequests actions mergeRequests pipelines") &&
          query.includes("sourceControlIntegrationState"),
      ),
    ).toBe(true);
  });

  test("keeps zero totals visible and distinguishes unavailable totals", async () => {
    integrationState = {
      github: { configured: true },
      gitlab: { configured: true },
    };
    providerActivity = {
      pullRequests: 0,
      actions: null,
      mergeRequests: 0,
      pipelines: null,
    };
    renderFooter();

    await screen.findByText("$1.25");
    for (const label of ["Pull Reqs", "Merge Reqs"]) {
      expect(
        within(
          screen.getByRole("link", { name: new RegExp(`^${label}`) }),
        ).getByText("0"),
      ).toBeDefined();
    }
    for (const [label, href] of [
      ["Actions", "/github/actions"],
      ["Pipelines", "/gitlab/pipelines"],
    ]) {
      const link = screen
        .getAllByRole("link", { name: new RegExp(`^${label}`) })
        .find((candidate) => candidate.getAttribute("href") === href)!;
      expect(within(link).getByText("—")).toBeDefined();
    }
  });

  test("refreshes counts and provider visibility when integration settings change", async () => {
    let notifyConfiguration!: () => void;
    subscriptions.mockReturnValue({
      subscribe: vi.fn(
        (
          { query }: { query: string },
          sink: {
            next: (result: {
              data: { integrationConfigurationChanged: string };
            }) => void;
          },
        ) => {
          if (query.includes("IntegrationConfigurationChanged"))
            notifyConfiguration = () =>
              sink.next({
                data: { integrationConfigurationChanged: "github" },
              });
          return vi.fn();
        },
      ),
    } as never);
    renderFooter();
    await screen.findByText("$1.25");
    expect(screen.queryByRole("link", { name: /^Pull Reqs/ })).toBeNull();

    integrationState = {
      github: { configured: true },
      gitlab: { configured: false },
    };
    await act(async () => notifyConfiguration());
    expect(
      within(await screen.findByRole("link", { name: /^Pull Reqs/ })).getByText(
        "12",
      ),
    ).toBeDefined();

    integrationState = {
      github: { configured: false },
      gitlab: { configured: true },
    };
    await act(async () => notifyConfiguration());
    await screen.findByRole("link", { name: /^Merge Reqs/ });
    expect(screen.queryByRole("link", { name: /^Pull Reqs/ })).toBeNull();
    expect(
      screen
        .queryAllByRole("link", { name: /^Actions/ })
        .some((link) => link.getAttribute("href") === "/github/actions"),
    ).toBe(false);
  });

  test("keeps the last totals during a failed status refresh", async () => {
    integrationState.github.configured = true;
    renderFooter();
    const pullRequests = await screen.findByRole("link", {
      name: /^Pull Reqs/,
    });
    request.mockRejectedValueOnce(new Error("Temporarily unavailable"));
    const recover = vi.mocked(onControlPlaneRecovery).mock.calls.at(-1)![0];
    await act(async () => recover({ initialConnection: false }));
    expect(within(pullRequests).getByText("12")).toBeDefined();
  });

  test.each([
    ["Workflows", "/dashboard/workflows"],
    ["Pull Reqs", "/github/pull-requests"],
    ["Actions", "/github/actions"],
    ["Merge Reqs", "/gitlab/merge-requests"],
    ["Pipelines", "/gitlab/pipelines"],
  ])(
    "closes the mobile navigation when %s is followed",
    async (label, href) => {
      setViewportWidth(390);
      integrationState = {
        github: { configured: true },
        gitlab: { configured: true },
      };
      renderFooter();

      await screen.findByText("$1.25");
      fireEvent.click(screen.getByRole("button", { name: "sheet closed" }));
      expect(screen.getByRole("button", { name: "sheet open" })).toBeTruthy();

      fireEvent.click(
        screen
          .getAllByRole("link", { name: new RegExp(`^${label}`) })
          .find((link) => link.getAttribute("href") === href)!,
      );

      expect(screen.getByRole("button", { name: "sheet closed" })).toBeTruthy();
    },
  );

  test("keeps the sidebar open on a desktop viewport", async () => {
    renderFooter();

    await screen.findByText("$1.25");
    fireEvent.click(screen.getByRole("button", { name: "sheet closed" }));
    fireEvent.click(screen.getByRole("link", { name: /Workflows/ }));

    expect(screen.getByRole("button", { name: "sheet open" })).toBeTruthy();
  });

  test("fills multi-agent circles with used disk space", async () => {
    request.mockImplementation(async (query) => {
      if (!String(query).includes("query SidebarStatus")) {
        throw new Error(`Unexpected operation: ${String(query)}`);
      }
      return {
        sidebarStatus: {
          ...sidebarStatus,
          activity: { ...sidebarStatus.activity, ...providerActivity },
          diskSummary: {
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
        sourceControlIntegrationState: integrationState,
        derivedDataDeletionHistory: { items: [] },
      } as never;
    });

    renderFooter();

    const circle = await screen.findByLabelText(
      "Builder · Derived Data: 100 GiB free",
    );
    expect(circle.style.background).toContain("var(--muted) 0% 20%");
    expect(circle.style.background).toContain("#f59e0b 20% 100%");
  });

  test("does not repeat initial reads on first connection and still reconciles reconnects", async () => {
    renderFooter();
    const calls = () =>
      request.mock.calls.filter(([query]) =>
        query.includes("query SidebarStatus"),
      );
    await waitFor(() => expect(calls()).toHaveLength(1));
    const recover = vi.mocked(onControlPlaneRecovery).mock.calls.at(-1)![0];
    await act(async () => recover({ initialConnection: true }));
    expect(calls()).toHaveLength(1);
    await act(async () => recover({ initialConnection: false }));
    await waitFor(() => expect(calls()).toHaveLength(2));
  });
});
