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

import { StartBuildButton } from "./start-build-dialog";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    children,
    href,
    ...props
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: navigation.push }),
}));

const request = vi.mocked(controlPlaneRequest);
const now = new Date().toISOString();
const observation = {
  id: "observation-1",
  scopeKey: "worktree:worktree-1",
  status: "VALID" as const,
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
          {
            type: "SIMULATOR",
            id: "SIM-1",
            name: "iPhone 17 Pro",
            platform: "iOS Simulator",
            osVersion: "26.0",
            state: "Booted",
          },
          {
            type: "PHYSICAL_DEVICE",
            id: "DEVICE-1",
            name: "iPhone",
            platform: "iOS",
            osVersion: "26.0",
            state: "connected",
          },
        ],
      } as never;
    }
    if (operation.includes("query ExportSigningInventory")) {
      return {
        signingAgents: [{ supported: true }],
        signingCertificates: [
          {
            sha1: "API-CERT",
            name: "Apple Development: Created via API (API123)",
            teamId: "API123",
            hasPrivateKey: true,
            installedAgents: [{ id: "agent-1" }],
          },
          {
            sha1: "OTHER-CERT",
            name: "Apple Distribution: Other Team (OTHER123)",
            teamId: "OTHER123",
            hasPrivateKey: true,
            installedAgents: [{ id: "agent-1" }],
          },
        ],
        signingProfiles: [
          {
            uuid: "PROFILE-APP",
            name: "Example Development",
            profileType: "DEVELOPMENT",
            bundleId: "com.example.app",
            teamId: "TEAM123",
            platforms: ["iOS"],
            expiresAt: "2030-01-01T00:00:00.000Z",
            expired: false,
            certificateSha1s: ["API-CERT"],
            installedAgents: [{ id: "agent-1" }],
          },
          {
            uuid: "PROFILE-WATCH",
            name: "Example Watch Development",
            profileType: "DEVELOPMENT",
            bundleId: "com.example.app.WatchKitApp",
            teamId: "TEAM123",
            platforms: ["iOS"],
            expiresAt: "2030-01-01T00:00:00.000Z",
            expired: false,
            certificateSha1s: ["API-CERT"],
            installedAgents: [{ id: "agent-1" }],
          },
          {
            uuid: "PROFILE-OTHER",
            name: "Other Enterprise Profile",
            profileType: "ENTERPRISE",
            bundleId: "com.example.other",
            teamId: "OTHER123",
            platforms: ["iOS"],
            expiresAt: "2030-01-01T00:00:00.000Z",
            expired: false,
            certificateSha1s: ["OTHER-CERT"],
            installedAgents: [{ id: "agent-1" }],
          },
        ],
      } as never;
    }
    if (operation.includes("mutation InspectStartBuildSigningRequirements")) {
      return {
        inspectBuildSource: {
          signingRequirements: [
            {
              bundleId: "com.example.app",
              name: "Example",
              target: "App",
              platform: "iOS",
              teamId: "TEAM123",
              provisioningProfileSpecifier: "Example Development",
            },
            {
              bundleId: "com.example.app.WatchKitApp",
              name: "Example Watch",
              target: "Example watchOS App",
              platform: "watchOS",
              teamId: "TEAM123",
              provisioningProfileSpecifier: "Example Watch Development",
            },
          ],
        },
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
  test("parses signing requirements while keeping manual signing overrides available", async () => {
    render(
      <StartBuildButton codebaseId="codebase-1" worktreeId="worktree-1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("sm:max-w-5xl");
    expect(await screen.findByText("Development")).toBeDefined();

    const actionField = within(dialog).getByText("Action").parentElement!;
    const actionSelect = within(actionField).getByRole("combobox");
    fireEvent.pointerDown(actionSelect, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Archive" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Export when complete" }),
    );

    const signingStyleField =
      within(dialog).getByText("Signing style").parentElement!;
    const signingStyleSelect = within(signingStyleField).getByRole("combobox");
    fireEvent.pointerDown(signingStyleSelect, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Manual" }));

    const parse = await screen.findByRole("button", {
      name: "Parse project",
    });
    await waitFor(() =>
      expect((parse as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(parse);

    expect(await screen.findByText("com.example.app")).toBeDefined();
    expect(screen.getByText("com.example.app.WatchKitApp")).toBeDefined();
    expect(screen.getByText(/Example Development/)).toBeDefined();
    expect(screen.getByText(/Example Watch Development/)).toBeDefined();

    const certificateField = within(dialog).getByText(
      "Signing certificate",
    ).parentElement!;
    fireEvent.pointerDown(within(certificateField).getByRole("combobox"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const apiCertificate = await screen.findByRole("option", {
      name: /Apple Development: Created via API/,
    });
    expect(apiCertificate).toBeDefined();
    const otherCertificate = screen.getByRole("option", {
      name: /Apple Distribution: Other Team.*May not match selected profiles/,
    });
    expect(otherCertificate.className).toContain("text-muted-foreground");
    expect(otherCertificate.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(otherCertificate);

    fireEvent.change(screen.getByLabelText("Bundle identifier to add"), {
      target: { value: "com.example.app.MissingExtension" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add bundle identifier" }),
    );
    const [manualBundleId] = await screen.findAllByText(
      "com.example.app.MissingExtension",
    );
    const manualBundleCard = manualBundleId.closest(
      "div.rounded-lg",
    ) as HTMLElement;
    fireEvent.pointerDown(within(manualBundleCard).getByRole("combobox"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const otherProfile = await screen.findByRole("option", {
      name: /Other Enterprise Profile.*May not match this bundle/,
    });
    expect(otherProfile.className).toContain("text-muted-foreground");
    expect(otherProfile.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(otherProfile);

    fireEvent.click(screen.getByRole("button", { name: "Parse again" }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([query]) =>
          String(query).includes(
            "mutation InspectStartBuildSigningRequirements",
          ),
        ),
      ).toHaveLength(2),
    );
    expect(
      await screen.findAllByText("com.example.app.MissingExtension"),
    ).not.toHaveLength(0);
    expect(
      screen.getByRole("button", {
        name: "Remove com.example.app.MissingExtension",
      }),
    ).toBeDefined();
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("InspectStartBuildSigningRequirements"),
        expect.objectContaining({
          input: expect.objectContaining({
            scheme: "App",
            configuration: "Debug",
          }),
        }),
      ),
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Start Build" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation StartIosBuild"),
        expect.objectContaining({
          input: expect.objectContaining({
            action: "ARCHIVE",
            exportWhenComplete: true,
            exportSettings: expect.objectContaining({
              provisioningProfiles: {
                "com.example.app": "PROFILE-APP",
                "com.example.app.WatchKitApp": "PROFILE-WATCH",
                "com.example.app.MissingExtension": "PROFILE-OTHER",
              },
              signingCertificate: "OTHER-CERT",
            }),
          }),
        }),
      ),
    );
  });

  test("links to repository settings when builds are not configured", async () => {
    render(
      <StartBuildButton
        buildSettingsHref="/codebases/repositories/repository-1"
        codebaseId="codebase-1"
        disabled
        disabledReason="Build settings are missing"
        worktreeId="worktree-1"
      />,
    );

    const buildButton = screen.getByRole("button", { name: "Build" });
    expect(buildButton.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.queryByRole("button", {
        name: "Go to repository settings to configure builds",
      }),
    ).toBeNull();

    fireEvent.click(buildButton);
    let settingsLink = await screen.findByRole("link", {
      name: "Go to repository settings to configure builds",
    });
    expect(settingsLink.getAttribute("href")).toBe(
      "/codebases/repositories/repository-1",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("link", {
          name: "Go to repository settings to configure builds",
        }),
      ).toBeNull(),
    );
    fireEvent.mouseEnter(buildButton);
    settingsLink = await screen.findByRole("link", {
      name: "Go to repository settings to configure builds",
    });
    expect(settingsLink).toBeDefined();
  });

  test("shows the test plan with primary settings for test actions", async () => {
    render(
      <StartBuildButton codebaseId="codebase-1" worktreeId="worktree-1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(await screen.findByText("Development")).toBeDefined();
    expect(screen.getByText("Valid")).toBeDefined();
    expect(screen.queryByText("VALID")).toBeNull();

    const dialog = screen.getByRole("dialog");
    const action = within(dialog).getAllByRole("combobox")[0]!;
    fireEvent.pointerDown(action, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Test" }));
    const testPlanLabel = await screen.findByText("Test plan");
    expect(testPlanLabel.closest("details")).toBeNull();
  });

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

    const device = screen.getAllByRole("combobox")[2]!;
    fireEvent.pointerDown(device, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(
      await screen.findByRole("option", { name: "Any iOS Simulator" }),
    ).toBeDefined();
    expect(screen.getByRole("option", { name: /iPhone 17 Pro/ })).toBeDefined();
    fireEvent.click(
      await screen.findByRole("option", { name: /iPhone 17 Pro/ }),
    );

    const destinationType = screen.getAllByRole("combobox")[1]!;
    fireEvent.pointerDown(destinationType, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "Physical Device" }),
    );
    fireEvent.pointerDown(device, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(
      await screen.findByRole("option", { name: "Any Physical iOS Device" }),
    ).toBeDefined();
    expect(screen.getByRole("option", { name: /iPhone/ })).toBeDefined();
    fireEvent.click(screen.getByRole("option", { name: /iPhone/ }));

    fireEvent.pointerDown(destinationType, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Simulator" }));
    fireEvent.pointerDown(device, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(
      await screen.findByRole("option", { name: /iPhone 17 Pro/ }),
    );

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
              id: "SIM-1",
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
