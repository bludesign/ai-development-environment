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
    fireEvent.click(selects[2]!);
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
    expect(within(dialog).getByText("ERROR")).toBeDefined();
    expect(
      (within(dialog).getAllByRole("combobox")[2] as HTMLButtonElement)
        .textContent,
    ).toContain("RemovedScheme");
  });
});
