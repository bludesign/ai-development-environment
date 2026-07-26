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
        name: "iPhone 17 Pro · 26.0",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("menuitem", { name: "Run" }));

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
});
