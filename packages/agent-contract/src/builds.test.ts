import { describe, expect, test } from "vitest";

import {
  BUILD_EXPORT_METHODS,
  BUILD_CONFIGURATION_ICON_KEYS,
  EXPORT_METHOD_PROFILE_TYPES,
  PROVISIONING_PROFILE_TYPES,
  profileCoversBundle,
  provisioningProfileType,
  DEFAULT_BUILD_ADVANCED_SETTINGS,
  parseBuildAdvancedSettings,
  parseBuildArtifactDownloadPayload,
  parseBuildDeletePayload,
  parseBuildJobPayload,
  parseBuildReportPayload,
  parseBuildSource,
  parseBuildSourceParsePayload,
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

  test("validates optional observability URLs and collection settings", () => {
    const telemetry = {
      localBaseUrl: "http://127.0.0.1:3000",
      remoteBaseUrl: "https://builds.example.com",
      selectedBaseUrl: "http://127.0.0.1:3000",
      consoleLogsUrl: "http://127.0.0.1:3000/api/telemetry/console-logs",
      analyticsEventsUrl:
        "http://127.0.0.1:3000/api/telemetry/analytics-events",
      consoleCollectionEnabled: true,
      analyticsCollectionEnabled: false,
    };
    expect(
      parseBuildJobPayload({ ...buildPayload(), telemetry }).telemetry,
    ).toEqual(telemetry);
    expect(() =>
      parseBuildJobPayload({
        ...buildPayload(),
        telemetry: { ...telemetry, selectedBaseUrl: "file:///tmp/events" },
      }),
    ).toThrow("HTTP(S)");
    expect(parseBuildJobPayload(buildPayload()).telemetry).toBeUndefined();
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

  test("maps every distribution method to a profile type", () => {
    for (const method of BUILD_EXPORT_METHODS) {
      expect(PROVISIONING_PROFILE_TYPES).toContain(
        EXPORT_METHOD_PROFILE_TYPES[method],
      );
    }
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
