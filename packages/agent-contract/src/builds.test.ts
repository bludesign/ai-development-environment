import { describe, expect, test } from "vitest";

import {
  DEFAULT_BUILD_ADVANCED_SETTINGS,
  parseBuildAdvancedSettings,
  parseBuildJobPayload,
  parseBuildSource,
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
