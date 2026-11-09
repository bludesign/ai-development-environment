import {
  act,
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

function inventory(agentId: string, simulators: Simulator[]) {
  return {
    refreshSimulatorInventory: terminal(agentId, {
      simulatorInventory: { simulators, runtimes: [] },
    }),
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
    const tvLink = await screen.findByRole(
      "link",
      { name: appleTv.name },
      { timeout: 5_000 },
    );
    expect(tvLink.getAttribute("href")).toBe(
      `/system/simulators/remote/${appleTv.id}`,
    );
    expect(
      (await screen.findByRole("link", { name: iphone.name })).getAttribute(
        "href",
      ),
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

  test("selects visible eligible devices within an agent group and drops selection on a scope change", async () => {
    const unavailable = {
      ...appleTv,
      id: "unavailable",
      name: "Old TV",
      state: "Creating",
      isAvailable: false,
    };
    const booted = { ...iphone, id: "booted" };
    const creating = {
      ...appleTv,
      id: "creating",
      name: "New TV",
      state: "Creating",
    };
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (query, variables, options) => {
      if (query.includes("mutation RefreshSimulatorInventory")) {
        const id = String(variables?.agentId);
        return inventory(
          id,
          id === "remote" ? [appleTv, unavailable, booted, creating] : [iphone],
        ) as never;
      }
      return fallback(query, variables, options);
    });
    render(
      <ActiveAgentProvider userId="simulator-test">
        <SimulatorsPage />
      </ActiveAgentProvider>,
    );
    await screen.findByRole("link", { name: unavailable.name });
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const remoteGroup = screen.getByRole("checkbox", {
      name: "Select all simulators on Remote Mac",
    });
    const studioGroup = screen.getByRole("checkbox", {
      name: "Select all simulators on Studio Mac",
    });
    expect((studioGroup as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() =>
      expect((remoteGroup as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Select ${appleTv.name}` }),
    );
    expect(remoteGroup.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(remoteGroup);
    expect(remoteGroup.getAttribute("aria-checked")).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: `Select ${unavailable.name}` })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (
        screen.getByRole("checkbox", {
          name: `Select ${creating.name}`,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("2 selected")).toBeTruthy();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search simulators" }),
      { target: { value: appleTv.name } },
    );
    expect(screen.getByText("0 selected")).toBeTruthy();
    fireEvent.click(remoteGroup);
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: activeAgentStorageKey("simulator-test"),
          newValue: JSON.stringify({ activeAgentId: "studio", pageAgents: {} }),
        }),
      ),
    );
    await screen.findByRole("link", { name: iphone.name });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(
      request.mock.calls.some(([query]) =>
        query.includes("mutation SimulatorAction"),
      ),
    ).toBe(false);
  });

  test("offers deletion for an unavailable Creating simulator and explains why apps cannot load", async () => {
    const unavailable = {
      ...appleTv,
      state: "Creating",
      isAvailable: false,
      availabilityError: "Runtime profile is unavailable",
    };
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (query, variables, options) => {
      if (query.includes("mutation InspectSimulator"))
        return {
          inspectSimulator: terminal("remote", {
            simulatorDetails: { simulator: unavailable, apps: [] },
          }),
        } as never;
      return fallback(query, variables, options);
    });
    render(
      <ActiveAgentProvider userId="simulator-test">
        <SimulatorDetailPage agentId="remote" simulatorId={unavailable.id} />
      </ActiveAgentProvider>,
    );
    await screen.findByText(
      "The simulator runtime is unavailable, so installed apps can’t be loaded.",
    );
    expect(
      screen.queryByText("Boot the simulator to load installed apps."),
    ).toBeNull();
    const remove = screen.getByRole("button", { name: "Delete simulator" });
    await waitFor(() =>
      expect((remove as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(remove);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Delete simulator",
      }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation SimulatorAction"),
        {
          input: expect.objectContaining({
            agentId: "remote",
            simulatorId: unavailable.id,
            action: "DELETE",
          }),
        },
        expect.anything(),
      ),
    );
  });

  test("deletes each agent's selection serially, refreshes each agent once, and retains eligible failures", async () => {
    const secondRemote = { ...appleTv, id: "second-remote", name: "Backup TV" };
    const studio = { ...appleTv, name: "Studio TV" };
    const devices = new Map([
      ["remote", [appleTv, secondRemote]],
      ["studio", [studio]],
    ]);
    const deleted = new Set<string>();
    const attempted: string[] = [];
    let finishFirst!: () => void;
    const firstRemote = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (query, variables, options) => {
      if (query.includes("mutation RefreshSimulatorInventory")) {
        const id = String(variables?.agentId);
        return inventory(
          id,
          (devices.get(id) ?? []).filter(
            (device) => !deleted.has(`${id}:${device.id}`),
          ),
        ) as never;
      }
      if (query.includes("mutation SimulatorAction")) {
        const input = variables?.input as {
          agentId: string;
          simulatorId: string;
          action: string;
        };
        expect(input.action).toBe("DELETE");
        const target = `${input.agentId}:${input.simulatorId}`;
        attempted.push(target);
        if (input.agentId === "remote" && input.simulatorId === appleTv.id)
          await firstRemote;
        if (input.simulatorId === secondRemote.id)
          return {
            performSimulatorAction: terminal(input.agentId, {
              status: "FAILED",
              error: "Device is busy",
            }),
          } as never;
        deleted.add(target);
        return { performSimulatorAction: terminal(input.agentId) } as never;
      }
      return fallback(query, variables, options);
    });
    render(
      <ActiveAgentProvider userId="simulator-test">
        <SimulatorsPage />
      </ActiveAgentProvider>,
    );
    await screen.findByRole("link", { name: studio.name });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const remoteGroup = screen.getByRole("checkbox", {
      name: "Select all simulators on Remote Mac",
    });
    await waitFor(() =>
      expect((remoteGroup as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(remoteGroup);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select all simulators on Studio Mac",
      }),
    );
    expect(screen.getByText("3 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(attempted).toEqual([]);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Delete selected",
      }),
    );
    try {
      await waitFor(() =>
        expect(attempted).toEqual([
          `remote:${appleTv.id}`,
          `studio:${studio.id}`,
        ]),
      );
    } finally {
      finishFirst();
    }
    await screen.findByText("Backup TV on Remote Mac — Device is busy");
    expect(attempted).toEqual([
      `remote:${appleTv.id}`,
      `studio:${studio.id}`,
      `remote:${secondRemote.id}`,
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: appleTv.name })).toBeNull(),
    );
    expect(screen.queryByRole("link", { name: studio.name })).toBeNull();
    expect(
      screen
        .getByRole("checkbox", { name: `Select ${secondRemote.name}` })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("1 selected")).toBeTruthy();
    const refreshes = request.mock.calls
      .filter(([query]) => query.includes("mutation RefreshSimulatorInventory"))
      .map(([, variables]) => variables?.agentId);
    expect(refreshes).toEqual(["remote", "studio", "remote", "studio"]);
  });

  test("reconciles the current agent and reports failures after switching scope during a confirmed batch", async () => {
    const studio = { ...appleTv, name: "Studio TV" };
    const remoteRefreshes: string[] = [];
    const attempted: string[] = [];
    let remoteDeleted = false;
    let finishRemote!: () => void;
    const remoteResult = new Promise<void>((resolve) => {
      finishRemote = resolve;
    });
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (query, variables, options) => {
      if (query.includes("mutation RefreshSimulatorInventory")) {
        const id = String(variables?.agentId);
        if (id === "remote") {
          remoteRefreshes.push(
            remoteDeleted ? "after delete" : "before delete",
          );
          return inventory(id, remoteDeleted ? [] : [appleTv]) as never;
        }
        return inventory(id, [studio]) as never;
      }
      if (query.includes("mutation SimulatorAction")) {
        const input = variables?.input as {
          agentId: string;
          simulatorId: string;
          action: string;
        };
        expect(input.action).toBe("DELETE");
        attempted.push(`${input.agentId}:${input.simulatorId}`);
        if (input.agentId === "studio")
          return {
            performSimulatorAction: terminal("studio", {
              status: "FAILED",
              error: "Device is busy",
            }),
          } as never;
        await remoteResult;
        remoteDeleted = true;
        return { performSimulatorAction: terminal("remote") } as never;
      }
      return fallback(query, variables, options);
    });
    render(
      <ActiveAgentProvider userId="simulator-test">
        <SimulatorsPage />
      </ActiveAgentProvider>,
    );
    await screen.findByRole("link", { name: studio.name });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const remoteGroup = screen.getByRole("checkbox", {
      name: "Select all simulators on Remote Mac",
    });
    await waitFor(() =>
      expect((remoteGroup as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(remoteGroup);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select all simulators on Studio Mac",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Delete selected",
      }),
    );
    try {
      await waitFor(() =>
        expect(attempted).toEqual([
          `remote:${appleTv.id}`,
          `studio:${studio.id}`,
        ]),
      );
      act(() =>
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: activeAgentStorageKey("simulator-test"),
            newValue: JSON.stringify({
              activeAgentId: "remote",
              pageAgents: {},
            }),
          }),
        ),
      );
      await waitFor(() =>
        expect(remoteRefreshes).toEqual(["before delete", "before delete"]),
      );
      expect(screen.getByText("Deleting selected simulators…")).toBeTruthy();
      expect(
        await screen.findByRole("link", { name: appleTv.name }),
      ).toBeTruthy();
    } finally {
      finishRemote();
    }
    await screen.findByText("Studio TV on Studio Mac — Device is busy");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: appleTv.name })).toBeNull(),
    );
    expect(remoteRefreshes).toEqual([
      "before delete",
      "before delete",
      "after delete",
    ]);
  });
});
