import { describe, expect, test } from "vitest";

import {
  BUILD_ENDPOINT_PATHS,
  BUILD_EXPORT_METHODS,
  BUILD_CONFIGURATION_ICON_KEYS,
  EXPORT_METHOD_PROFILE_TYPES,
  PROVISIONING_PROFILE_TYPES,
  profileCoversBundle,
  provisioningProfileType,
  buildDestinationSpecifier,
  genericBuildDestinations,
  parseBuildAgentRunDestinationsPayload,
  parseBuildDestination,
  DEFAULT_BUILD_ADVANCED_SETTINGS,
  parseBuildAdvancedSettings,
  parseBuildArtifactDownloadPayload,
  parseBuildDeletePayload,
  parseBuildJobPayload,
  parseBuildReportPayload,
  parseBuildSource,
  parseBuildSourceParsePayload,
  resolveCollectDsyms,
} from "./builds.js";

const destination = {
  type: "SIMULATOR",
  id: "SIMULATOR-1",
  name: "iPhone 17 Pro",
  platform: "iOS Simulator",
  osVersion: "26.0",
  state: "Booted",
};

function buildPayload() {
  return {
    codebaseId: "codebase-1",
    worktreeId: "worktree-1",
    folder: "/tmp/repository",
    gitDirectory: "/tmp/repository/.git",
    expectedOrigin: "github.com/example/app",
    headSha: "abc123",
    buildId: "build-1",
    artifactDirectory: "/tmp/builds/build-1",
    source: { kind: "WORKSPACE", relativePath: "App.xcworkspace" },
    scheme: "App",
    configuration: "Debug",
    action: "BUILD",
    destination,
    advancedSettings: DEFAULT_BUILD_ADVANCED_SETTINGS,
    scripts: [],
  };
}

describe("iOS build agent contract", () => {
  test("encodes platform-specific destinations and keeps legacy iOS inputs valid", () => {
    expect(buildDestinationSpecifier(parseBuildDestination(destination))).toBe(
      "platform=iOS Simulator,id=SIMULATOR-1",
    );
    expect(
      genericBuildDestinations("ARCHIVE", ["TVOS", "MAC_CATALYST"]).map(
        buildDestinationSpecifier,
      ),
    ).toEqual([
      "generic/platform=tvOS",
      "generic/platform=macOS,variant=Mac Catalyst",
    ]);
    expect(
      buildDestinationSpecifier(
        parseBuildDestination({
          ...destination,
          type: "PHYSICAL_DEVICE",
          platform: "tvOS",
          platformId: "TVOS",
          id: "CORE-1",
          xcodeId: "UDID-1",
        }),
      ),
    ).toBe("platform=tvOS,id=UDID-1");
    expect(
      buildDestinationSpecifier(
        parseBuildDestination({
          ...destination,
          platform: "visionOS Simulator",
          platformId: "VISIONOS_DESIGNED_FOR_IPAD",
          variant: "Designed for [iPad,iPhone]",
        }),
      ),
    ).toBe(
      "platform=visionOS Simulator,variant=Designed for iPad,id=SIMULATOR-1",
    );
  });

  test("accepts platform-specific run discovery alongside legacy jobs", () => {
    expect(
      parseBuildAgentRunDestinationsPayload({ destinationType: "SIMULATOR" }),
    ).toEqual({ destinationType: "SIMULATOR" });
    expect(
      parseBuildAgentRunDestinationsPayload({
        destinationType: "PHYSICAL_DEVICE",
        platforms: [
          "IOS",
          "MACOS_DESIGNED_FOR_IPAD",
          "VISIONOS_DESIGNED_FOR_IPAD",
        ],
      }).platforms,
    ).toEqual(["IOS", "MACOS_DESIGNED_FOR_IPAD", "VISIONOS_DESIGNED_FOR_IPAD"]);
  });

  test("preserves cache ownership and validates script resource scopes with legacy defaults", () => {
    const script = {
      id: "hook",
      name: "Hook",
      preBuildScript: "export default () => {}",
      postBuildScript: null,
      timeoutSeconds: 30,
      failureBehavior: "FAIL_BUILD",
      position: 0,
    };
    expect(
      parseBuildJobPayload({
        ...buildPayload(),
        derivedDataPath: "/Builds/.worktree-derived-data/worktree-1",
        scripts: [script],
      }),
    ).toMatchObject({
      derivedDataPath: "/Builds/.worktree-derived-data/worktree-1",
      scripts: [{ lockScope: "WORKTREE" }],
    });
    expect(
      parseBuildJobPayload({
        ...buildPayload(),
        scripts: [{ ...script, lockScope: "AGENT" }],
      }).scripts[0]?.lockScope,
    ).toBe("AGENT");
    expect(() =>
      parseBuildJobPayload({
        ...buildPayload(),
        scripts: [{ ...script, lockScope: "ALL" }],
      }),
    ).toThrow("lockScope");
  });
  test("accepts the expanded configuration icon catalog", () => {
    expect(BUILD_CONFIGURATION_ICON_KEYS).toContain("apple");
    expect(BUILD_CONFIGURATION_ICON_KEYS).toContain("terminal");
    expect(BUILD_CONFIGURATION_ICON_KEYS).toContain("wrench");
  });

  test("captures an optional configuration when inspecting a source", () => {
    expect(
      parseBuildSourceParsePayload({
        codebaseId: "codebase-1",
        worktreeId: "worktree-1",
        folder: "/tmp/repository",
        gitDirectory: "/tmp/repository/.git",
        expectedOrigin: "github.com/example/app",
        headSha: "abc123",
        source: { kind: "WORKSPACE", relativePath: "App.xcworkspace" },
        scheme: "App",
        configuration: "Release",
      }),
    ).toMatchObject({ scheme: "App", configuration: "Release" });
  });

  test("defaults test-result parsing on for saved and legacy settings", () => {
    expect(parseBuildAdvancedSettings({}).parseTestResults).toBe(true);
    expect(
      parseBuildAdvancedSettings({ parseTestResults: false }).parseTestResults,
    ).toBe(false);
  });

  test("validates build report jobs and their build-folder containment", () => {
    expect(
      parseBuildReportPayload({
        buildId: "build-1",
        artifactDirectory: "/tmp/builds/build-1",
        codebaseId: "codebase-1",
        reportKind: "TEST_RESULTS",
        source: "MANUAL",
      }),
    ).toMatchObject({ reportKind: "TEST_RESULTS", source: "MANUAL" });
    expect(() =>
      parseBuildReportPayload({
        buildId: "build-1",
        artifactDirectory: "/tmp/builds/other",
        codebaseId: "codebase-1",
        reportKind: "CODE_COVERAGE",
        source: "MANUAL",
      }),
    ).toThrow("must end with the build ID");
  });

  test("limits build deletion to the folder named by the build ID", () => {
    expect(
      parseBuildDeletePayload({
        buildId: "build-1",
        artifactDirectory: "/tmp/builds/build-1",
        codebaseId: "codebase-1",
      }),
    ).toEqual({
      buildId: "build-1",
      artifactDirectory: "/tmp/builds/build-1",
      codebaseId: "codebase-1",
    });
    expect(() =>
      parseBuildDeletePayload({
        buildId: "build-1",
        artifactDirectory: "/tmp/builds/build-2",
        codebaseId: "codebase-1",
      }),
    ).toThrow("must end with the build ID");
  });

  test("accepts only contained build artifact paths", () => {
    expect(
      parseBuildArtifactDownloadPayload({
        buildId: "build-1",
        artifactDirectory: "/tmp/builds/build-1",
        artifactRelativePath: "products/App.app",
        uploadId: "upload-1",
        codebaseId: "codebase-1",
      }),
    ).toMatchObject({ artifactRelativePath: "products/App.app" });
    expect(() =>
      parseBuildArtifactDownloadPayload({
        buildId: "build-1",
        artifactDirectory: "/tmp/builds/build-1",
        artifactRelativePath: "../secret",
        uploadId: "upload-1",
        codebaseId: "codebase-1",
      }),
    ).toThrow("stay within the worktree");
  });

  test("accepts only contained Xcode sources and a root Swift package", () => {
    expect(
      parseBuildSource({ kind: "PROJECT", relativePath: "ios/App.xcodeproj" }),
    ).toEqual({ kind: "PROJECT", relativePath: "ios/App.xcodeproj" });
    expect(
      parseBuildSource({ kind: "PACKAGE", relativePath: "Package.swift" }),
    ).toEqual({ kind: "PACKAGE", relativePath: "Package.swift" });
    expect(() =>
      parseBuildSource({
        kind: "WORKSPACE",
        relativePath: "../App.xcworkspace",
      }),
    ).toThrow("stay within the worktree");
    expect(() =>
      parseBuildSource({ kind: "PACKAGE", relativePath: "ios/Package.swift" }),
    ).toThrow("worktree root");
  });

  test("maps typed advanced settings and rejects unapproved build overrides", () => {
    expect(
      parseBuildAdvancedSettings({
        ...DEFAULT_BUILD_ADVANCED_SETTINGS,
        packageResolution: "RESOLVED_ONLY",
        signingStyle: "MANUAL",
        developmentTeam: "TEAM123",
        parallelTesting: true,
        parallelTestingWorkers: 4,
        onlyTesting: ["AppTests/LoginTests"],
        buildSettingOverrides: {
          ONLY_ACTIVE_ARCH: "YES",
          OTHER_SWIFT_FLAGS: "-DUI_TESTING",
        },
      }),
    ).toMatchObject({
      packageResolution: "RESOLVED_ONLY",
      signingStyle: "MANUAL",
      developmentTeam: "TEAM123",
      parallelTestingWorkers: 4,
      buildSettingOverrides: {
        ONLY_ACTIVE_ARCH: "YES",
        OTHER_SWIFT_FLAGS: "-DUI_TESTING",
      },
    });
    expect(() =>
      parseBuildAdvancedSettings({
        ...DEFAULT_BUILD_ADVANCED_SETTINGS,
        buildSettingOverrides: { DERIVED_DATA_DIR: "/tmp/DerivedData" },
      }),
    ).toThrow("not approved");
  });

  test("collects dSYMs automatically for archives only", () => {
    const automatic = parseBuildAdvancedSettings({});
    expect(automatic.collectDsyms).toBeNull();
    expect(resolveCollectDsyms(automatic, "ARCHIVE")).toBe(true);
    expect(resolveCollectDsyms(automatic, "BUILD")).toBe(false);
    expect(
      resolveCollectDsyms(
        parseBuildAdvancedSettings({ collectDsyms: true }),
        "BUILD",
      ),
    ).toBe(true);
    expect(
      resolveCollectDsyms(
        parseBuildAdvancedSettings({ collectDsyms: false }),
        "ARCHIVE",
      ),
    ).toBe(false);
    expect(() => parseBuildAdvancedSettings({ collectDsyms: "yes" })).toThrow(
      "collectDsyms must be a boolean or null",
    );
  });

  test("requires a normalized absolute captured test path", () => {
    expect(
      parseBuildAdvancedSettings({
        ...DEFAULT_BUILD_ADVANCED_SETTINGS,
        priorBuildForTestingId: "build-for-testing-1",
        priorTestProductsPath:
          "/agent/builds/build-for-testing-1/test-products.xctestproducts",
      }).priorTestProductsPath,
    ).toBe("/agent/builds/build-for-testing-1/test-products.xctestproducts");
    expect(
      parseBuildAdvancedSettings({
        ...DEFAULT_BUILD_ADVANCED_SETTINGS,
        priorBuildForTestingId: "build-for-testing-1",
        priorXctestrunPath: "/agent/builds/build-for-testing-1/App.xctestrun",
      }).priorXctestrunPath,
    ).toBe("/agent/builds/build-for-testing-1/App.xctestrun");
    expect(() =>
      parseBuildAdvancedSettings({
        ...DEFAULT_BUILD_ADVANCED_SETTINGS,
        priorXctestrunPath: "test-products/App.xctestrun",
      }),
    ).toThrow("absolute normalized path");
    expect(() =>
      parseBuildAdvancedSettings({
        ...DEFAULT_BUILD_ADVANCED_SETTINGS,
        priorXctestrunPath: "/agent/builds/../outside/App.xctestrun",
      }),
    ).toThrow("absolute normalized path");
  });

  test("takes immutable script snapshots and rejects duplicate scripts", () => {
    const payload = buildPayload();
    const script = {
      id: "script-1",
      name: "Lint",
      preBuildScript: "console.log('lint')",
      postBuildScript: null,
      timeoutSeconds: 30,
      failureBehavior: "FAIL_BUILD",
      position: 0,
    };
    expect(
      parseBuildJobPayload({ ...payload, scripts: [script] }).scripts[0],
    ).toMatchObject({ id: "script-1", name: "Lint", position: 0 });
    expect(() =>
      parseBuildJobPayload({ ...payload, scripts: [script, { ...script }] }),
    ).toThrow("must be unique");
  });

  test("validates shared server snapshots, endpoint paths, and collection flags", () => {
    const telemetry = {
      consoleCollectionEnabled: true,
      analyticsCollectionEnabled: false,
    };
    const server = {
      localBaseUrl: "http://127.0.0.1:3000",
      remoteBaseUrl: "https://builds.example.com",
      proxyBaseUrl: "https://aide.ts.net",
      selectedUrlKind: "PROXY",
      selectedBaseUrl: "https://aide.ts.net",
    };
    const parsed = parseBuildJobPayload({
      ...buildPayload(),
      server,
      endpointPaths: BUILD_ENDPOINT_PATHS,
      telemetry,
    });
    expect(parsed.server).toEqual(server);
    expect(parsed.endpointPaths).toEqual(BUILD_ENDPOINT_PATHS);
    expect(parsed.telemetry).toEqual(telemetry);
    expect(Object.keys(parsed.endpointPaths!)).not.toContain("sse");
    expect(() =>
      parseBuildJobPayload({
        ...buildPayload(),
        server: { ...server, selectedBaseUrl: "file:///tmp/events" },
      }),
    ).toThrow("HTTP(S)");
    expect(() =>
      parseBuildJobPayload({
        ...buildPayload(),
        server: { ...server, selectedBaseUrl: server.localBaseUrl },
      }),
    ).toThrow("must match");
    expect(() =>
      parseBuildJobPayload({
        ...buildPayload(),
        endpointPaths: {
          ...BUILD_ENDPOINT_PATHS,
          consoleLogs: "https://aide.ts.net/api/telemetry/console-logs",
        },
      }),
    ).toThrow("endpoint path");
    expect(parseBuildJobPayload(buildPayload()).server).toBeUndefined();
  });

  test("enforces action-specific destination and test-product invariants", () => {
    expect(() =>
      parseBuildJobPayload({ ...buildPayload(), action: "ARCHIVE" }),
    ).toThrow("generic physical destination");
    expect(() =>
      parseBuildJobPayload({
        ...buildPayload(),
        destination: {
          ...destination,
          id: "generic-ios-simulator",
          generic: true,
        },
      }),
    ).not.toThrow();
    expect(() =>
      parseBuildJobPayload({
        ...buildPayload(),
        action: "TEST",
        destination: {
          ...destination,
          id: "generic-ios-simulator",
          generic: true,
        },
      }),
    ).toThrow("concrete destination");
    expect(() =>
      parseBuildJobPayload({
        ...buildPayload(),
        action: "TEST_WITHOUT_BUILDING",
      }),
    ).toThrow("captured Build for Testing result");
  });
});

describe("provisioning profile classification", () => {
  test("separates development from distribution by get-task-allow", () => {
    expect(
      provisioningProfileType({
        getTaskAllow: true,
        hasProvisionedDevices: true,
        provisionsAllDevices: false,
      }),
    ).toBe("DEVELOPMENT");
  });

  test("separates ad hoc from app store by the device list", () => {
    expect(
      provisioningProfileType({
        getTaskAllow: false,
        hasProvisionedDevices: true,
        provisionsAllDevices: false,
      }),
    ).toBe("AD_HOC");
    expect(
      provisioningProfileType({
        getTaskAllow: false,
        hasProvisionedDevices: false,
        provisionsAllDevices: false,
      }),
    ).toBe("APP_STORE");
  });

  test("treats an all-device claim as enterprise", () => {
    expect(
      provisioningProfileType({
        getTaskAllow: false,
        hasProvisionedDevices: false,
        provisionsAllDevices: true,
      }),
    ).toBe("ENTERPRISE");
  });

  test("identifies Developer ID profiles by their signing certificate", () => {
    expect(
      provisioningProfileType({
        getTaskAllow: false,
        hasProvisionedDevices: false,
        provisionsAllDevices: true,
        hasDeveloperIdCertificate: true,
      }),
    ).toBe("DEVELOPER_ID");
  });

  test("maps distribution methods that support a profile to a profile type", () => {
    for (const method of BUILD_EXPORT_METHODS) {
      const type = EXPORT_METHOD_PROFILE_TYPES[method];
      if (method === "MAC_APPLICATION") expect(type).toBeNull();
      else expect(PROVISIONING_PROFILE_TYPES).toContain(type);
    }
    expect(EXPORT_METHOD_PROFILE_TYPES.DEVELOPER_ID).toBe("DEVELOPER_ID");
  });
});

describe("profileCoversBundle", () => {
  test("matches an exact bundle identifier", () => {
    expect(profileCoversBundle("com.example.App", "com.example.App")).toBe(
      true,
    );
    expect(profileCoversBundle("com.example.App", "com.example.Other")).toBe(
      false,
    );
  });

  test("does not treat a prefix as a match without a wildcard", () => {
    expect(
      profileCoversBundle("com.example.App", "com.example.App.Watch"),
    ).toBe(false);
  });

  test("honours a trailing wildcard", () => {
    expect(profileCoversBundle("com.example.*", "com.example.App")).toBe(true);
    expect(profileCoversBundle("com.example.*", "com.other.App")).toBe(false);
  });

  test("treats a bare wildcard as covering everything", () => {
    expect(profileCoversBundle("*", "com.anything.At.All")).toBe(true);
  });
});
