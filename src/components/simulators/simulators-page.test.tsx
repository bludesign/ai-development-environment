import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ActiveAgentProvider,
  activeAgentStorageKey,
} from "@/components/active-agent/active-agent-provider";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { SimulatorDetailPage } from "./simulator-detail-page";
import type { Simulator } from "./simulator-client";
import { SimulatorsPage } from "./simulators-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const capabilities = [
  "simulators.inventory",
  "simulators.inspect",
  "simulators.action",
  "simulators.create",
  "simulators.reset",
];
const agents = [
  {
    id: "studio",
    name: "Studio Mac",
    hostname: "studio.local",
    connectionStatus: "ONLINE",
    capabilities,
  },
  {
    id: "remote",
    name: "Remote Mac",
    hostname: "remote.local",
    connectionStatus: "ONLINE",
    capabilities,
  },
];
const appleTv: Simulator = {
  id: "same-udid",
  name: "Apple TV QA",
  runtimeId: "tvos-27",
  runtimeName: "tvOS 27.2",
  platform: "tvOS",
  deviceTypeId: "apple-tv",
  state: "Shutdown",
  isAvailable: true,
  availabilityError: null,
  dataPath:
    "/Users/agent/Library/Developer/CoreSimulator/Devices/same-udid/data",
};
const iphone: Simulator = {
  ...appleTv,
  name: "iPhone QA",
  runtimeId: "ios-27",
  runtimeName: "iOS 27.2",
  platform: "iOS",
  deviceTypeId: "iphone",
  state: "Booted",
};
const weather = {
  bundleId: "com.acme.weather",
  name: "Acme Weather",
  version: "2.0",
  build: "10",
  bundlePath: `${appleTv.dataPath}/Weather.app`,
  dataPath: `${appleTv.dataPath}/weather-data`,
};

function terminal(agentId: string, fields: Record<string, unknown> = {}) {
  return {
    id: `job-${agentId}`,
    agentId,
    status: "SUCCEEDED",
    error: null,
    ...fields,
  };
}

describe("Simulator management", () => {
  beforeEach(() => {
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockImplementation(async (query, variables) => {
      if (query.includes("query ActiveAgentOptions"))
        return { agents } as never;
      if (query.includes("mutation RefreshSimulatorInventory")) {
        const agentId = String(variables?.agentId);
        return {
          refreshSimulatorInventory: terminal(agentId, {
            simulatorInventory: {
              simulators: [agentId === "remote" ? appleTv : iphone],
              runtimes: [],
            },
          }),
        } as never;
      }
      if (query.includes("mutation InspectSimulator"))
        return {
          inspectSimulator: terminal("studio", {
            simulatorDetails: { simulator: iphone, apps: [weather] },
          }),
        } as never;
      if (query.includes("mutation SimulatorAction"))
        return { performSimulatorAction: terminal("remote") } as never;
      throw new Error(`Unexpected operation: ${query}`);
    });
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
    localStorage.removeItem(activeAgentStorageKey("simulator-test"));
  });

  test("groups same-UDID devices by agent, searches runtimes, and starts the correct simulator", async () => {
    render(
      <ActiveAgentProvider userId="simulator-test">
        <SimulatorsPage />
      </ActiveAgentProvider>,
    );
    const tvLink = await screen.findByRole("link", { name: appleTv.name });
    expect(tvLink.getAttribute("href")).toBe(
      `/system/simulators/remote/${appleTv.id}`,
    );
    expect(
      screen.getByRole("link", { name: iphone.name }).getAttribute("href"),
    ).toBe(`/system/simulators/studio/${iphone.id}`);
    expect(screen.getByRole("link", { name: "Studio Mac" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Remote Mac" })).toBeTruthy();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search simulators" }),
      { target: { value: "tvOS 27.2" } },
    );
    expect(screen.queryByRole("link", { name: iphone.name })).toBeNull();
    const row = tvLink.closest("tr")!;
    await waitFor(() =>
      expect(
        (
          within(row).getByRole("button", {
            name: "Start",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(within(row).getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation SimulatorAction"),
        {
          input: expect.objectContaining({
            agentId: "remote",
            simulatorId: appleTv.id,
            action: "BOOT",
          }),
        },
        expect.anything(),
      ),
    );
  });

  test("inspects the detail route's owning agent even when another agent is active", async () => {
    localStorage.setItem(
      activeAgentStorageKey("simulator-test"),
      JSON.stringify({ activeAgentId: "remote", pageAgents: {} }),
    );
    render(
      <ActiveAgentProvider userId="simulator-test">
        <SimulatorDetailPage agentId="studio" simulatorId={iphone.id} />
      </ActiveAgentProvider>,
    );
    await screen.findByText("Acme Weather");
    expect(screen.getByRole("heading", { name: iphone.name })).toBeTruthy();
    expect(
      screen.getByText("Shut down the simulator before deleting it.", {
        exact: false,
      }),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Delete simulator",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation InspectSimulator"),
      expect.objectContaining({ agentId: "studio", simulatorId: iphone.id }),
      expect.anything(),
    );
    const appMenu = screen.getByRole("button", {
      name: "Actions for Acme Weather",
    });
    fireEvent.keyDown(appMenu, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Open app data in Finder on Studio Mac",
      }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation SimulatorAction"),
        {
          input: {
            agentId: "studio",
            simulatorId: iphone.id,
            action: "OPEN_APP_DATA_FOLDER",
            bundleId: weather.bundleId,
            requestId: expect.any(String),
          },
        },
        expect.anything(),
      ),
    );
  });
});
