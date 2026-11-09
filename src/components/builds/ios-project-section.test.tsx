import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { IosProjectSection } from "./ios-project-section";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const now = new Date().toISOString();

beforeEach(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query IosProjectSection")) {
      return {
        iosAppProject: {
          id: "project-1",
          type: "IOS_APP",
          defaultDestinationType: "SIMULATOR",
          configurations: [
            {
              id: "configuration-1",
              name: "Legacy Development",
              iconKey: "hammer",
              source: {
                id: "source-1",
                kind: "WORKSPACE",
                relativePath: "App.xcworkspace",
              },
              scheme: "RemovedScheme",
              buildConfiguration: "LegacyDebug",
              defaultAction: "BUILD_FOR_TESTING",
              advancedSettings: { testPlan: "TestPlan" },
              observation: {
                id: "observation-1",
                scopeKey: "worktree:worktree-1",
                status: "ERROR",
                schemes: ["CurrentScheme"],
                configurations: ["Debug", "Release"],
                testPlans: ["TestPlan"],
                error: "Scheme was removed",
                stale: true,
                headSha: "abc123",
                xcodeVersion: "Xcode 26.0",
                lastParseAttemptAt: now,
                lastParsedAt: now,
              },
              createdAt: now,
              updatedAt: now,
            },
          ],
          allowedScripts: [],
        },
        buildScripts: [],
        worktreeOverview: {
          agents: [
            {
              codebases: [
                {
                  codebase: { id: "codebase-1" },
                  worktrees: [{ id: "worktree-1", primary: true }],
                },
              ],
            },
          ],
        },
      } as never;
    }
    if (operation.includes("mutation DiscoverBuildSources")) {
      return {
        discoverBuildSources: [
          { kind: "WORKSPACE", relativePath: "App.xcworkspace" },
        ],
      } as never;
    }
    if (operation.includes("mutation InspectBuildSource")) {
      throw new Error("Xcode metadata is unavailable");
    }
    throw new Error(`Unexpected request: ${operation}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("iOS project source card", () => {
  test("saves the repository default destination type and retains it on failure", async () => {
    const original = request.getMockImplementation()!;
    let saves = 0;
    request.mockImplementation(async (query, variables) => {
      if (String(query).includes("mutation UpdateIosAppProject")) {
        saves += 1;
        if (saves > 1) throw new Error("Could not save destination");
        return {
          updateIosAppProject: { defaultDestinationType: "PHYSICAL_DEVICE" },
        } as never;
      }
      return original(query, variables);
    });
    render(<IosProjectSection codebaseId="codebase-1" />);
    const selector = await screen.findByRole("combobox", {
      name: "Default destination type",
    });
    expect(selector.textContent).toContain("Simulator");
    fireEvent.click(selector);
    fireEvent.click(
      await screen.findByRole("option", { name: "Physical Device" }),
    );
    await waitFor(() =>
      expect(selector.textContent).toContain("Physical Device"),
    );
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation UpdateIosAppProject"),
      {
        id: "project-1",
        defaultDestinationType: "PHYSICAL_DEVICE",
      },
    );
    fireEvent.click(selector);
    fireEvent.click(await screen.findByRole("option", { name: "Simulator" }));
    expect(await screen.findByText("Could not save destination")).toBeDefined();
    expect(selector.textContent).toContain("Physical Device");
  });

  test("uses a wide configuration dialog with labeled icon previews", async () => {
    render(<IosProjectSection codebaseId="codebase-1" />);

    expect(await screen.findByText("Legacy Development")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("sm:max-w-5xl");

    const iconSelect = within(dialog).getByRole("button", {
      name: "Icon: Build",
    });
    fireEvent.pointerDown(iconSelect, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const terminalOption = await screen.findByRole("menuitemradio", {
      name: "Command line",
    });
    expect(terminalOption.querySelector("svg")).not.toBeNull();
    expect(
      screen.getByRole("menuitemradio", { name: "Security" }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitemradio", { name: "Feature" }),
    ).toBeDefined();
    fireEvent.click(terminalOption);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("retains unavailable saved selections and stale metadata after reparse failure", async () => {
    render(<IosProjectSection codebaseId="codebase-1" />);

    expect(await screen.findByText("Legacy Development")).toBeDefined();
    expect(screen.getByText("RemovedScheme · LegacyDebug")).toBeDefined();
    expect(screen.getByText(/stale metadata/)).toBeDefined();
    expect(screen.getByText("Scheme was removed")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("TestPlan")).toBeDefined();
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DiscoverBuildSources"),
        expect.anything(),
      ),
    );
    const selects = within(dialog).getAllByRole("combobox");
    fireEvent.click(selects[1]!);
    expect(
      await screen.findAllByText("RemovedScheme · saved value unavailable"),
    ).toHaveLength(2);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Reparse" }));
    expect(
      await within(dialog).findByText("Xcode metadata is unavailable"),
    ).toBeDefined();
    expect(within(dialog).getByText("stale metadata")).toBeDefined();
    expect(within(dialog).getByText("Error")).toBeDefined();
    expect(
      (within(dialog).getAllByRole("combobox")[1] as HTMLButtonElement)
        .textContent,
    ).toContain("RemovedScheme");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("saves a tvOS scheme override independently of the shared scheme", async () => {
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (query, variables) => {
      if (query.includes("mutation InspectBuildSource")) {
        return {
          inspectBuildSource: {
            source: { kind: "WORKSPACE", relativePath: "App.xcworkspace" },
            schemes: ["RemovedScheme", "TVApp"],
            configurations: ["LegacyDebug"],
            platforms: ["TVOS"],
            testPlans: ["TestPlan"],
          },
        } as never;
      }
      if (query.includes("mutation SaveBuildConfiguration")) {
        return { saveBuildConfiguration: { id: "configuration-1" } } as never;
      }
      if (query.includes("mutation ReparseSavedBuildConfiguration")) {
        return {
          reparseBuildConfiguration: { id: "observation-1", status: "VALID" },
        } as never;
      }
      return original(query, variables);
    });
    render(<IosProjectSection codebaseId="codebase-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "tvOS" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit tvOS settings" }));
    const editor = within(
      await screen.findByRole("dialog", { name: "Edit tvOS settings" }),
    );
    fireEvent.click(await editor.findByRole("combobox", { name: "Scheme" }));
    fireEvent.click(await screen.findByRole("option", { name: "TVApp" }));
    const useSettings = editor.getByRole("button", { name: "Use settings" });
    await waitFor(() =>
      expect(useSettings.hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(useSettings);
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation SaveBuildConfiguration"),
        {
          input: expect.objectContaining({
            scheme: "RemovedScheme",
            platformConfigurations: [
              { platform: "IOS" },
              { platform: "TVOS", scheme: "TVApp" },
            ],
          }),
        },
      ),
    );
  });
});
