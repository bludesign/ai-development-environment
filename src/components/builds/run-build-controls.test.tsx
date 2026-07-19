import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { RunBuildControls } from "./run-build-controls";

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
});
