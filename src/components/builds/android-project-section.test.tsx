import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import {
  AndroidBuildConfigurationDialog,
  AndroidProjectSection,
} from "./android-project-section";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const availableWorktree = (id: string, primary = true) => ({
  id,
  primary,
  availability: "AVAILABLE",
});

beforeEach(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  request.mockReset();
});

test.each([
  { buildReady: true, canInspect: true, checkout: "sdk-checkout" },
  { buildReady: false, canInspect: true, checkout: "java-checkout" },
  { buildReady: false, canInspect: false, checkout: "discover-only" },
])(
  "uses $checkout for source operations across repository checkouts",
  async ({ buildReady, canInspect, checkout }) => {
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
                      availableWorktree("java-checkout"),
                    ],
                  },
                ],
              },
              {
                agent: {
                  connectionStatus: buildReady ? "ONLINE" : "OFFLINE",
                  capabilities: [discover, inspect, "android.build.run"],
                },
                codebases: [
                  {
                    repository: { id: "repository-1" },
                    worktrees: [availableWorktree("sdk-checkout")],
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
        checkouts={[
          {
            codebaseId: "online",
            label: "Builder",
            androidBuildStatus: "ready",
          },
          {
            codebaseId: "offline",
            label: "Laptop",
            androidBuildStatus: "offline",
          },
          {
            codebaseId: "tools",
            label: "Runner",
            androidBuildStatus: "missingTools",
          },
        ]}
        codebaseId="codebase-1"
        repositoryId="repository-1"
      />,
    );
    const add = await screen.findByRole("button", {
      name: "Add Android configuration",
    });
    expect(
      screen.getByText(/Save a configuration to enable the Build button/),
    ).toBeDefined();
    expect(screen.getByText("Agent offline")).toBeDefined();
    expect(screen.getByText("Android build tools ready")).toBeDefined();
    expect(screen.getByText("Android build support unavailable")).toBeDefined();
    expect(screen.getByText(/Android SDK Command-line Tools/)).toBeDefined();
    fireEvent.click(add);
    const projectPath = await screen.findByRole("combobox", {
      name: "Gradle project path",
    });
    expect(projectPath.textContent).toContain("mobile");

    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation DiscoverAndroidBuildSources"),
      expect.objectContaining({ worktreeId: checkout }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    if (!canInspect) {
      expect(
        screen.queryByRole("button", { name: "Inspect build variants" }),
      ).toBeNull();
      expect(
        screen.getByText(/You can enter the module and variant manually/),
      ).toBeDefined();
      return;
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect build variants" }),
    );
    await screen.findByText(
      "No Android application variants found in this project.",
    );
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation InspectAndroidBuildSource"),
      expect.objectContaining({
        worktreeId: checkout,
        projectPath: "mobile",
      }),
    );
    expect(screen.getByLabelText<HTMLInputElement>("Build variant").value).toBe(
      "debug",
    );
  },
);

test("preserves an explicitly entered root project path during discovery", async () => {
  const discovery = Promise.withResolvers<{
    discoverAndroidBuildSources: string[];
  }>();
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query AndroidDiscoveryCheckout")) {
      return {
        worktreeOverview: {
          agents: [
            {
              agent: {
                connectionStatus: "ONLINE",
                capabilities: ["android.source.discover"],
              },
              codebases: [
                {
                  repository: { id: "repository-1" },
                  worktrees: [availableWorktree("checkout")],
                },
              ],
            },
          ],
        },
      } as never;
    }
    if (operation.includes("mutation DiscoverAndroidBuildSources")) {
      return discovery.promise as never;
    }
    throw new Error(`Unexpected operation: ${operation}`);
  });

  render(
    <AndroidBuildConfigurationDialog
      codebaseId="codebase-1"
      configuration={null}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      repositoryId="repository-1"
    />,
  );

  const dialog = within(await screen.findByRole("dialog"));
  await dialog.findByRole("button", { name: /Discover Gradle projects/ });
  const projectPath = dialog.getByRole("textbox", {
    name: "Gradle project path",
  });
  fireEvent.change(projectPath, { target: { value: "mobile" } });
  fireEvent.change(projectPath, { target: { value: "." } });
  discovery.resolve({ discoverAndroidBuildSources: ["mobile"] });

  await dialog.findByRole("combobox", { name: "Gradle project path" });
  expect(
    dialog.getByLabelText<HTMLInputElement>("Manual Gradle project path").value,
  ).toBe(".");
});

test("preserves saved fields during discovery and saves a selected flavor and icon", async () => {
  const configuration = {
    id: "configuration-1",
    name: "Development",
    iconKey: "hammer",
    projectPath: "saved-project",
    module: ":app",
    variant: "customDebug",
    apkPath: null,
  };
  const saved = {
    ...configuration,
    iconKey: "smartphone",
    module: ":demo",
    variant: "demoRelease",
  };
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query AndroidDiscoveryCheckout")) {
      return {
        worktreeOverview: {
          agents: [
            {
              agent: {
                connectionStatus: "ONLINE",
                capabilities: [
                  "android.source.discover",
                  "android.source.inspect",
                ],
              },
              codebases: [
                {
                  repository: { id: "repository-1" },
                  worktrees: [availableWorktree("checkout")],
                },
              ],
            },
          ],
        },
      } as never;
    }
    if (operation.includes("mutation DiscoverAndroidBuildSources")) {
      return { discoverAndroidBuildSources: ["other-project"] } as never;
    }
    if (operation.includes("mutation InspectAndroidBuildSource")) {
      return {
        inspectAndroidBuildSource: [
          { module: ":app", variants: ["debug", "release"] },
          { module: ":demo", variants: ["demoDebug", "demoRelease"] },
        ],
      } as never;
    }
    if (operation.includes("mutation SaveAndroidBuildConfiguration")) {
      return { saveAndroidBuildConfiguration: saved } as never;
    }
    throw new Error(`Unexpected operation: ${operation}`);
  });

  const onSaved = vi.fn();
  render(
    <AndroidBuildConfigurationDialog
      codebaseId="codebase-1"
      configuration={configuration}
      onClose={vi.fn()}
      onSaved={onSaved}
      repositoryId="repository-1"
    />,
  );

  const dialog = within(await screen.findByRole("dialog"));
  await dialog.findByRole("combobox", { name: "Gradle project path" });
  expect(
    dialog.getByLabelText<HTMLInputElement>("Manual Gradle project path").value,
  ).toBe("saved-project");
  fireEvent.click(
    dialog.getByRole("button", { name: "Inspect build variants" }),
  );
  const moduleSelect = await dialog.findByRole("combobox", {
    name: "Application module",
  });
  expect(
    dialog.getByLabelText<HTMLInputElement>("Manual build variant").value,
  ).toBe("customDebug");

  fireEvent.keyDown(moduleSelect, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: ":demo" }));
  fireEvent.keyDown(dialog.getByRole("combobox", { name: "Build variant" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("option", { name: "demoRelease" }));

  fireEvent.pointerDown(dialog.getByRole("button", { name: "Icon: Build" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Mobile app" }),
  );
  expect(
    dialog.getByRole("button", { name: "Icon: Mobile app" }),
  ).toBeDefined();
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  expect(request).toHaveBeenCalledWith(
    expect.stringContaining("mutation SaveAndroidBuildConfiguration"),
    { input: { ...saved, codebaseId: "codebase-1" } },
  );
});
