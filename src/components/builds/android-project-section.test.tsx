import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { AndroidProjectSection } from "./android-project-section";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const availableWorktree = (id: string, primary = true) => ({
  id,
  primary,
  availability: "AVAILABLE",
});

afterEach(() => {
  cleanup();
  request.mockReset();
});

test.each([true, false])(
  "finds source operations across repository checkouts (inspection available: %s)",
  async (canInspect) => {
    const discover = "android.source.discover";
    const inspect = "android.source.inspect";
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query AndroidAppProject")) {
        return {
          androidAppProject: { id: "project-1", androidConfigurations: [] },
        } as never;
      }
      if (operation.includes("query AndroidDiscoveryCheckout")) {
        return {
          worktreeOverview: {
            agents: [
              {
                agent: {
                  connectionStatus: "ONLINE",
                  capabilities: [discover, inspect],
                },
                codebases: [
                  {
                    repository: { id: "unrelated-repository" },
                    worktrees: [availableWorktree("unrelated")],
                  },
                ],
              },
              {
                agent: {
                  connectionStatus: "ONLINE",
                  capabilities: [discover],
                },
                codebases: [
                  {
                    repository: { id: "repository-1" },
                    worktrees: [availableWorktree("discover-only")],
                  },
                ],
              },
              {
                agent: {
                  connectionStatus: canInspect ? "ONLINE" : "OFFLINE",
                  capabilities: [discover, inspect],
                },
                codebases: [
                  {
                    repository: { id: "repository-1" },
                    worktrees: [
                      availableWorktree("secondary", false),
                      availableWorktree("sdk-checkout"),
                    ],
                  },
                ],
              },
            ],
          },
        } as never;
      }
      if (operation.includes("mutation DiscoverAndroidBuildSources")) {
        return { discoverAndroidBuildSources: ["mobile"] } as never;
      }
      if (operation.includes("mutation InspectAndroidBuildSource")) {
        return { inspectAndroidBuildSource: [] } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });

    render(
      <AndroidProjectSection
        codebaseId="codebase-1"
        repositoryId="repository-1"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Add Android configuration" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Discover Gradle projects" }),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText<HTMLInputElement>("Gradle project path").value,
      ).toBe("mobile"),
    );

    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation DiscoverAndroidBuildSources"),
      expect.objectContaining({
        worktreeId: canInspect ? "sdk-checkout" : "discover-only",
      }),
    );

    if (!canInspect) {
      expect(
        screen.queryByRole("button", { name: "Inspect Gradle modules" }),
      ).toBeNull();
      return;
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect Gradle modules" }),
    );
    await screen.findByText(
      "No Android application variants found in this project.",
    );
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation InspectAndroidBuildSource"),
      expect.objectContaining({
        worktreeId: "sdk-checkout",
        projectPath: "mobile",
      }),
    );
  },
);
