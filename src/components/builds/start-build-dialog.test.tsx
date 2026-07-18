import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { StartBuildButton } from "./start-build-dialog";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

const request = vi.mocked(controlPlaneRequest);
const now = new Date().toISOString();
const observation = {
  id: "observation-1",
  scopeKey: "worktree:worktree-1",
  status: "UNPARSED" as const,
  schemes: ["App"],
  configurations: ["Debug", "Release"],
  testPlans: [],
  error: null,
  stale: false,
  headSha: "abc123",
  xcodeVersion: "Xcode 26.0",
  lastParseAttemptAt: now,
  lastParsedAt: now,
};

beforeEach(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  navigation.push.mockReset();
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query StartBuildProject")) {
      return {
        builds: { items: [] },
        iosAppProject: {
          id: "project-1",
          type: "IOS_APP",
          configurations: [
            {
              id: "configuration-1",
              name: "Development",
              iconKey: "hammer",
              source: {
                id: "source-1",
                kind: "WORKSPACE",
                relativePath: "App.xcworkspace",
              },
              scheme: "App",
              buildConfiguration: "Debug",
              defaultAction: "BUILD",
              advancedSettings: {},
              observation,
              createdAt: now,
              updatedAt: now,
            },
          ],
          allowedScripts: [
            {
              position: 0,
              script: {
                id: "script-1",
                name: "Generate Sources",
                preBuildScript: "console.log('generate')",
                postBuildScript: null,
                enabledByDefault: true,
                timeoutSeconds: 60,
                failureBehavior: "FAIL_BUILD",
              },
            },
          ],
        },
      } as never;
    }
    if (operation.includes("mutation ReparseStartBuild")) {
      return { reparseBuildConfiguration: observation } as never;
    }
    if (operation.includes("mutation InspectStartBuildDestinations")) {
      return {
        inspectBuildDestinations: [
          {
            type: "SIMULATOR",
            id: "generic-ios-simulator",
            name: "Any iOS Simulator",
            platform: "iOS Simulator",
            osVersion: null,
            state: null,
            generic: true,
          },
          {
            type: "PHYSICAL_DEVICE",
            id: "generic-ios",
            name: "Any Physical iOS Device",
            platform: "iOS",
            osVersion: null,
            state: null,
            generic: true,
          },
        ],
      } as never;
    }
    if (operation.includes("mutation StartIosBuild")) {
      return { startBuild: { id: "build-1" } } as never;
    }
    throw new Error(`Unexpected request: ${operation}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StartBuildDialog", () => {
  test("preflights a configuration, previews a safe command, validates overrides, and snapshots default scripts", async () => {
    render(
      <StartBuildButton codebaseId="codebase-1" worktreeId="worktree-1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    expect(await screen.findByText("Development")).toBeDefined();
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation InspectStartBuildDestinations"),
        expect.objectContaining({
          input: expect.objectContaining({
            worktreeId: "worktree-1",
            configurationId: "configuration-1",
          }),
        }),
      ),
    );
    expect(
      screen.getByText(/xcrun xcodebuild -workspace App\.xcworkspace/),
    ).toBeDefined();
    expect(
      request.mock.calls.some(([query]) =>
        String(query).includes("mutation ReparseStartBuild"),
      ),
    ).toBe(false);
    expect(
      screen.getByText(/-hideShellScriptEnvironment/).textContent,
    ).not.toContain("derivedDataPath");
    expect(
      screen
        .getByRole("checkbox", { name: /Generate Sources/ })
        .getAttribute("data-state"),
    ).toBe("checked");

    fireEvent.change(
      screen.getByLabelText(/Approved build-setting overrides/),
      {
        target: { value: "[" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Start Build" }));
    expect(
      await screen.findByText("Build-setting overrides must be a JSON object."),
    ).toBeDefined();

    fireEvent.change(
      screen.getByLabelText(/Approved build-setting overrides/),
      {
        target: { value: '{"ONLY_ACTIVE_ARCH":"YES"}' },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Start Build" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation StartIosBuild"),
        {
          input: expect.objectContaining({
            worktreeId: "worktree-1",
            configurationId: "configuration-1",
            destination: expect.objectContaining({
              id: "generic-ios-simulator",
              generic: true,
            }),
            scriptIds: ["script-1"],
            action: "BUILD",
            advancedSettings: {
              buildSettingOverrides: { ONLY_ACTIVE_ARCH: "YES" },
            },
            requestId: expect.any(String),
          }),
        },
      ),
    );
    expect(navigation.push).toHaveBeenCalledWith("/builds/build-1");
  });
});
