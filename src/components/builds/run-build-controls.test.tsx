import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { RunBuildControls } from "./run-build-controls";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

beforeEach(() => vi.clearAllMocks());

afterEach(cleanup);

describe("RunBuildControls", () => {
  test("preselects the concrete destination used for the build", () => {
    render(
      <RunBuildControls
        buildId="build-1"
        destinationType="SIMULATOR"
        onError={vi.fn()}
        preferredDestination={{
          type: "SIMULATOR",
          id: "SIM-1",
          name: "iPhone 17 Pro",
          platform: "iOS Simulator",
          osVersion: "26.0",
          state: "Booted",
        }}
      />,
    );

    expect(screen.getByRole("button", { name: /1 devices/ })).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("does not preselect a generic destination", () => {
    render(
      <RunBuildControls
        buildId="build-1"
        destinationType="SIMULATOR"
        onError={vi.fn()}
        preferredDestination={{
          type: "SIMULATOR",
          id: "generic-ios-simulator",
          name: "Any iOS Simulator",
          platform: "iOS Simulator",
          osVersion: null,
          state: null,
          generic: true,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Run devices" })).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("runs from one compact device-picker button", async () => {
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("BuildRunDestinations")) {
        return {
          inspectBuildRunDestinations: [
            {
              type: "SIMULATOR",
              id: "SIM-1",
              name: "iPhone 17 Pro",
              platform: "iOS Simulator",
              osVersion: "26.0",
              state: "Booted",
            },
          ],
        } as never;
      }
      if (operation.includes("RunCompletedBuild")) {
        return {
          runBuild: [{ id: "deployment-1", status: "QUEUED" }],
        } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
    const completed = vi.fn();
    render(
      <RunBuildControls
        buildId="build-1"
        compact
        destinationType="SIMULATOR"
        onCompleted={completed}
        onError={vi.fn()}
        preferredDestination={{
          type: "SIMULATOR",
          id: "SIM-1",
          name: "iPhone 17 Pro",
          platform: "iOS Simulator",
          osVersion: "26.0",
          state: "Booted",
        }}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Run" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      await screen.findByRole("menuitemcheckbox", {
        name: /iPhone 17 Pro.*iOS Simulator 26.0.*Booted/,
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Run Selected" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("RunCompletedBuild"),
        expect.objectContaining({
          input: expect.objectContaining({
            buildId: "build-1",
            destinations: [expect.objectContaining({ id: "SIM-1" })],
          }),
        }),
      ),
    );
    expect(completed).toHaveBeenCalledOnce();
  });

  test("supports row selection, quick run, select all, clear, and unavailable devices", async () => {
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("BuildRunDestinations")) {
        return {
          inspectBuildRunDestinations: [
            {
              type: "SIMULATOR",
              id: "SIM-1",
              name: "iPhone 17 Pro",
              platform: "iOS",
              osVersion: "27.0",
              state: "Booted",
              available: true,
            },
            {
              type: "SIMULATOR",
              id: "SIM-2",
              name: "iPad Pro",
              platform: "iOS",
              osVersion: "27.0",
              state: "Shutdown",
              available: true,
            },
            {
              type: "SIMULATOR",
              id: "SIM-OFFLINE",
              name: "Offline iPhone",
              platform: "iOS",
              osVersion: "26.4",
              state: "Offline",
              available: false,
            },
          ],
        } as never;
      }
      if (operation.includes("RunCompletedBuild")) {
        return { runBuild: [{ id: "deployment", status: "QUEUED" }] } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
    render(
      <RunBuildControls
        buildId="build-1"
        destinationType="SIMULATOR"
        onError={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Run devices" }), {
      button: 0,
      ctrlKey: false,
    });
    const ipad = await screen.findByRole("menuitemcheckbox", {
      name: /iPad Pro.*iOS 27.0.*Shutdown/,
    });
    const offline = screen.getByRole("menuitemcheckbox", {
      name: /Offline iPhone.*iOS 26.4.*Offline/,
    });
    expect((offline as HTMLButtonElement).disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Run on Offline iPhone",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(ipad);
    fireEvent.click(screen.getByRole("button", { name: "Run on iPad Pro" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("RunCompletedBuild"),
        expect.objectContaining({
          input: expect.objectContaining({
            destinations: [expect.objectContaining({ id: "SIM-2" })],
          }),
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Select All" }));
    expect(ipad.getAttribute("aria-checked")).toBe("true");
    expect(offline.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(ipad.getAttribute("aria-checked")).toBe("false");
  });

  test("searches devices by name, platform, OS version, and state", async () => {
    request.mockResolvedValue({
      inspectBuildRunDestinations: [
        {
          type: "SIMULATOR",
          id: "SIM-1",
          name: "iPhone 17 Pro",
          platform: "iOS",
          osVersion: "27.0",
          state: "Booted",
          available: true,
        },
        {
          type: "SIMULATOR",
          id: "SIM-2",
          name: "Offline iPad",
          platform: "iPadOS",
          osVersion: "26.4",
          state: "Offline",
          available: false,
        },
      ],
    } as never);
    render(
      <RunBuildControls
        buildId="build-1"
        destinationType="SIMULATOR"
        onError={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Run devices" }), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findByRole("menuitemcheckbox", { name: /iPhone 17 Pro/ });
    const search = screen.getByRole("searchbox", { name: "Search devices…" });

    fireEvent.change(search, { target: { value: "26.4" } });
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Offline iPad/ }),
    ).toBeDefined();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: /iPhone 17 Pro/ }),
    ).toBeNull();

    fireEvent.change(search, { target: { value: "connected" } });
    expect(screen.getByText("No devices match your search.")).toBeDefined();

    fireEvent.change(search, { target: { value: "booted" } });
    expect(
      screen.getByRole("menuitemcheckbox", { name: /iPhone 17 Pro/ }),
    ).toBeDefined();
  });
});
