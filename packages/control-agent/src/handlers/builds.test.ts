import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_BUILD_ADVANCED_SETTINGS,
  type BuildJobPayload,
} from "@ai-development-environment/agent-contract/builds";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";

import type { ProcessResult } from "../process-runner.js";

import {
  classifyFailure,
  createRedactor,
  deleteIosBuild,
  downloadIosBuildArtifact,
  generateIosBuildReport,
  genericBuildDestinations,
  physicalDestinations,
  runIosBuild,
  simulatorAppArguments,
  archiveApplicationProperties,
  exportedArtifacts,
  simulatorDestinations,
  signingRequirementsFromBuildSettings,
  testPlanNames,
  workspaceProjectPaths,
  xcodeBuildArguments,
  xcodeBuildSettingsArguments,
} from "./builds.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

function payload(overrides: Partial<BuildJobPayload> = {}): BuildJobPayload {
  return {
    codebaseId: "codebase-1",
    worktreeId: "worktree-1",
    folder: "/tmp/App",
    gitDirectory: "/tmp/App/.git",
    expectedOrigin: "github.com/example/app",
    headSha: "abc123",
    buildId: "build-1",
    artifactDirectory: "/tmp/Builds/build-1",
    source: { kind: "WORKSPACE", relativePath: "App.xcworkspace" },
    scheme: "App",
    configuration: "Debug",
    action: "BUILD",
    destination: {
      type: "SIMULATOR",
      id: "SIM-1",
      name: "iPhone 17 Pro",
      platform: "iOS Simulator",
      osVersion: "26.0",
      state: "Booted",
    },
    advancedSettings: DEFAULT_BUILD_ADVANCED_SETTINGS,
    scripts: [],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("iOS build command construction", () => {
  test("maps every supported action without overriding Derived Data", () => {
    const actions = {
      BUILD: "build",
      TEST: "test",
      ANALYZE: "analyze",
      ARCHIVE: "archive",
      BUILD_FOR_TESTING: "build-for-testing",
      TEST_WITHOUT_BUILDING: "test-without-building",
    } as const;

    for (const [action, argument] of Object.entries(actions)) {
      const args = xcodeBuildArguments(
        payload({ action: action as BuildJobPayload["action"] }),
      );
      expect(args.at(-1)).toBe(argument);
      expect(args).not.toContain("-derivedDataPath");
      expect(args.some((value) => /derived.?data/i.test(value))).toBe(false);
      if (action === "BUILD_FOR_TESTING") {
        expect(args).toEqual(
          expect.arrayContaining([
            "-testProductsPath",
            "/tmp/Builds/build-1/test-products.xctestproducts",
          ]),
        );
      }
    }
  });

  test("maps typed package, signing, test, and approved override settings", () => {
    const args = xcodeBuildArguments(
      payload({
        advancedSettings: {
          ...DEFAULT_BUILD_ADVANCED_SETTINGS,
          packageResolution: "RESOLVED_ONLY",
          disablePackageRepositoryCache: true,
          signingStyle: "MANUAL",
          developmentTeam: "TEAM123",
          provisioningProfileSpecifier: "App Development",
          allowProvisioningUpdates: true,
          testPlan: "Integration",
          codeCoverage: true,
          parallelTesting: true,
          parallelTestingWorkers: 3,
          onlyTesting: ["AppTests/LoginTests"],
          skipTesting: ["AppTests/SlowTests"],
          buildSettingOverrides: { ONLY_ACTIVE_ARCH: "YES" },
        },
      }),
    );

    expect(args).toEqual(
      expect.arrayContaining([
        "-onlyUsePackageVersionsFromResolvedFile",
        "-disablePackageRepositoryCache",
        "CODE_SIGN_STYLE=Manual",
        "DEVELOPMENT_TEAM=TEAM123",
        "PROVISIONING_PROFILE_SPECIFIER=App Development",
        "-allowProvisioningUpdates",
        "-testPlan",
        "Integration",
        "-enableCodeCoverage",
        "YES",
        "-parallel-testing-worker-count",
        "3",
        "-only-testing:AppTests/LoginTests",
        "-skip-testing:AppTests/SlowTests",
        "ONLY_ACTIVE_ARCH=YES",
      ]),
    );
  });

  test("applies build overrides when inspecting runnable app metadata", () => {
    const args = xcodeBuildSettingsArguments(
      payload({
        advancedSettings: {
          ...DEFAULT_BUILD_ADVANCED_SETTINGS,
          productBundleIdentifier: "com.example.overridden",
          buildSettingOverrides: { MARKETING_VERSION: "2.0" },
        },
      }),
    );

    expect(args).toEqual(
      expect.arrayContaining([
        "PRODUCT_BUNDLE_IDENTIFIER=com.example.overridden",
        "MARKETING_VERSION=2.0",
        "-showBuildSettings",
      ]),
    );
  });

  test("uses the captured absolute xctestrun for Test Without Building", () => {
    const priorPath = "/tmp/Builds/prior/test-products/App.xctestrun";
    const args = xcodeBuildArguments(
      payload({
        action: "TEST_WITHOUT_BUILDING",
        advancedSettings: {
          ...DEFAULT_BUILD_ADVANCED_SETTINGS,
          priorBuildForTestingId: "prior",
          priorXctestrunPath: priorPath,
        },
      }),
    );
    expect(args.slice(args.indexOf("-xctestrun"), -1)).toEqual([
      "-xctestrun",
      priorPath,
    ]);
    expect(args).not.toContain("-project");
    expect(args).not.toContain("-workspace");
    expect(args).not.toContain("-scheme");
    expect(args).not.toContain("-configuration");
  });

  test("uses captured Xcode 26 test products for Test Without Building", () => {
    const priorPath = "/tmp/Builds/prior/test-products.xctestproducts";
    const args = xcodeBuildArguments(
      payload({
        action: "TEST_WITHOUT_BUILDING",
        advancedSettings: {
          ...DEFAULT_BUILD_ADVANCED_SETTINGS,
          priorBuildForTestingId: "prior",
          priorTestProductsPath: priorPath,
        },
      }),
    );
    expect(args.slice(args.indexOf("-testProductsPath"), -1)).toEqual([
      "-testProductsPath",
      priorPath,
    ]);
    expect(args).not.toContain("-xctestrun");
    expect(args).not.toContain("-project");
    expect(args).not.toContain("-workspace");
    expect(args).not.toContain("-scheme");
    expect(args).not.toContain("-configuration");
  });
});

describe("iOS destination and error parsing", () => {
  test("extracts signable application and extension requirements", () => {
    expect(
      signingRequirementsFromBuildSettings([
        {
          target: "App",
          buildSettings: {
            PRODUCT_BUNDLE_IDENTIFIER: "com.example.app",
            PRODUCT_NAME: "Example",
            PRODUCT_TYPE: "com.apple.product-type.application",
            PLATFORM_NAME: "iphoneos",
            DEVELOPMENT_TEAM: "TEAM123",
            PROVISIONING_PROFILE_SPECIFIER: "Example Development",
          },
        },
        {
          target: "Widget",
          buildSettings: {
            PRODUCT_BUNDLE_IDENTIFIER: "com.example.app.widget",
            PRODUCT_NAME: "Example Widget",
            PRODUCT_TYPE: "com.apple.product-type.app-extension",
            PLATFORM_NAME: "iphoneos",
          },
        },
        {
          target: "AppTests",
          buildSettings: {
            PRODUCT_BUNDLE_IDENTIFIER: "com.example.app.tests",
            PRODUCT_TYPE: "com.apple.product-type.bundle.unit-test",
          },
        },
      ]),
    ).toEqual([
      {
        bundleId: "com.example.app",
        name: "Example",
        target: "App",
        platform: "iOS",
        teamId: "TEAM123",
        provisioningProfileSpecifier: "Example Development",
      },
      {
        bundleId: "com.example.app.widget",
        name: "Example Widget",
        target: "Widget",
        platform: "iOS",
        teamId: null,
        provisioningProfileSpecifier: null,
      },
    ]);
  });

  test("parses Xcode test-plan objects", () => {
    expect(
      testPlanNames([{ name: "TestPlan" }, { name: "Integration" }]),
    ).toEqual(["Integration", "TestPlan"]);
  });

  test("offers generic simulator and physical targets for build-now/run-later", () => {
    expect(genericBuildDestinations("BUILD")).toEqual([
      expect.objectContaining({ type: "SIMULATOR", generic: true }),
      expect.objectContaining({ type: "PHYSICAL_DEVICE", generic: true }),
    ]);
    expect(genericBuildDestinations("TEST")).toEqual([]);
    expect(
      xcodeBuildArguments(
        payload({
          destination: {
            type: "SIMULATOR",
            id: "generic-ios-simulator",
            name: "Any iOS Simulator",
            platform: "iOS Simulator",
            osVersion: null,
            state: null,
            generic: true,
          },
        }),
      ),
    ).toContain("generic/platform=iOS Simulator");
  });

  test("reads only contained projects referenced by a workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-workspace-fixture-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "App.xcworkspace");
    const appProject = join(root, "App.xcodeproj");
    const nestedProject = join(root, "Nested App.xcodeproj");
    const unrelatedProject = join(root, "Unrelated.xcodeproj");
    const outside = await mkdtemp(join(tmpdir(), "ios-outside-project-"));
    temporaryDirectories.push(outside);
    await Promise.all([
      mkdir(workspace),
      mkdir(appProject),
      mkdir(nestedProject),
      mkdir(unrelatedProject),
    ]);
    await symlink(outside, join(root, "Outside.xcodeproj"));
    await writeFile(
      join(workspace, "contents.xcworkspacedata"),
      `<?xml version="1.0" encoding="UTF-8"?>
       <Workspace version="1.0">
         <FileRef location="group:App.xcodeproj"/>
         <FileRef location="container:Nested%20App.xcodeproj"/>
         <FileRef location="group:Outside.xcodeproj"/>
         <FileRef location="absolute:${unrelatedProject}"/>
       </Workspace>`,
    );

    expect(
      await workspaceProjectPaths(
        await realpath(workspace),
        await realpath(root),
      ),
    ).toEqual([await realpath(appProject), await realpath(nestedProject)]);
  });

  test("parses available iOS simulators and physical devices", () => {
    expect(
      simulatorDestinations({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
            {
              udid: "SIM-1",
              name: "iPhone 17 Pro",
              state: "Shutdown",
              isAvailable: true,
            },
            { udid: "OLD", name: "Unavailable", isAvailable: false },
          ],
          "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [],
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "SIMULATOR",
        id: "SIM-1",
        osVersion: "26.0",
      }),
    ]);
    expect(
      physicalDestinations({
        result: {
          devices: [
            {
              identifier: "DEVICE-1",
              hardwareProperties: { platform: "iOS" },
              deviceProperties: {
                name: "Test iPhone",
                osVersionNumber: "26.0",
              },
              connectionProperties: { tunnelState: "connected" },
            },
            {
              identifier: "MAC-1",
              hardwareProperties: { platform: "macOS" },
            },
          ],
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "PHYSICAL_DEVICE",
        id: "DEVICE-1",
        name: "Test iPhone",
      }),
    ]);
  });

  test("opens the selected simulator UI without using a shell command", () => {
    expect(simulatorAppArguments("SIM-1")).toEqual([
      "-a",
      "Simulator",
      "--args",
      "-CurrentDeviceUDID",
      "SIM-1",
    ]);
  });

  test("classifies actionable Xcode failures", () => {
    expect(classifyFailure("scheme App is not currently configured")).toBe(
      "MISSING_SCHEME",
    );
    expect(classifyFailure("Unable to find a destination matching")).toBe(
      "DESTINATION_UNAVAILABLE",
    );
    expect(classifyFailure("No provisioning profile found")).toBe(
      "SIGNING_FAILED",
    );
    expect(classifyFailure("Could not resolve package dependencies")).toBe(
      "PACKAGE_RESOLUTION_FAILED",
    );
  });

  test("redacts known values, credentials, tokens, and private keys", () => {
    const redact = createRedactor({ API_TOKEN: "known-secret" });
    expect(
      redact(
        "known-secret Bearer abc.def https://user:pass@example.com API_KEY=value\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      ),
    ).not.toMatch(
      /known-secret|abc\.def|user:pass|API_KEY=value|BEGIN PRIVATE KEY/,
    );
  });
});

describe("iOS build hooks and logs", () => {
  test("atomically persists normalized test and coverage reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-build-report-"));
    temporaryDirectories.push(root);
    const artifactDirectory = join(root, "build-1");
    const bin = join(root, "bin");
    await mkdir(join(artifactDirectory, "result.xcresult"), {
      recursive: true,
    });
    await mkdir(bin);
    const xcrun = join(bin, "xcrun");
    await writeFile(
      xcrun,
      `#!/bin/sh
case " $* " in
  *" xcresulttool "*)
    printf '%s' '{"padding":"'
    head -c 2097153 /dev/zero | tr '\\000' x
    printf '%s' '","devices":[],"testPlanConfigurations":[],"testNodes":[{"nodeType":"Test Plan","name":"Plan","children":[{"nodeType":"Unit test bundle","name":"AppTests","children":[{"nodeType":"Test Suite","name":"LoginTests","children":[{"nodeType":"Test Case","name":"testLogin()","nodeIdentifier":"LoginTests/testLogin()","result":"Passed","durationInSeconds":0.25}]}]}]}]}' ;;
  *) printf '%s' '{"coveredLines":8,"executableLines":10,"lineCoverage":0.8,"targets":[{"name":"App","files":[{"name":"App.swift","path":"/tmp/App.swift","coveredLines":8,"executableLines":10,"lineCoverage":0.8,"functions":[]}]}]}' ;;
esac
`,
    );
    await chmod(xcrun, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const testResult = (await generateIosBuildReport(
        {
          buildId: "build-1",
          artifactDirectory,
          codebaseId: "codebase-1",
          reportKind: "TEST_RESULTS",
          source: "MANUAL",
        },
        30_000,
        new AbortController().signal,
        async () => undefined,
      )) as ProcessResult & {
        report: {
          status: string;
          summary: Record<string, unknown>;
          data: Record<string, unknown>;
        };
      };
      expect(testResult.report).toMatchObject({
        status: "READY",
        summary: { total: 1, passed: 1, failed: 0 },
        data: {
          tests: [
            expect.objectContaining({
              bundle: "AppTests",
              suite: "LoginTests",
              file: "LoginTests",
            }),
          ],
        },
      });
      expect(
        JSON.parse(
          await readFile(join(artifactDirectory, "test-results.json"), "utf8"),
        ),
      ).toHaveProperty("testNodes");
      expect(
        (await stat(join(artifactDirectory, "test-results.json"))).size,
      ).toBeGreaterThan(2 * 1024 * 1024);

      const coverageResult = (await generateIosBuildReport(
        {
          buildId: "build-1",
          artifactDirectory,
          codebaseId: "codebase-1",
          reportKind: "CODE_COVERAGE",
          source: "MANUAL",
        },
        30_000,
        new AbortController().signal,
        async () => undefined,
      )) as ProcessResult & {
        report: { status: string; summary: Record<string, unknown> };
      };
      expect(coverageResult.report).toMatchObject({
        status: "READY",
        summary: { coveredLines: 8, executableLines: 10 },
      });
      expect(
        JSON.parse(
          await readFile(join(artifactDirectory, "code-coverage.json"), "utf8"),
        ),
      ).toHaveProperty("targets");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("deletes a completed build folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-build-delete-"));
    temporaryDirectories.push(root);
    const artifactDirectory = join(root, "build-1");
    await mkdir(artifactDirectory);

    await expect(
      deleteIosBuild(
        { buildId: "build-1", artifactDirectory, codebaseId: "codebase-1" },
        30_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(stat(artifactDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("cancels a test build without starting report generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-build-cancel-report-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const bin = join(root, "bin");
    const artifactDirectory = join(root, "build-cancelled");
    const buildStarted = join(root, "build-started");
    const invocations = join(root, "xcrun-invocations");
    await mkdir(join(repository, "App.xcworkspace"), { recursive: true });
    await mkdir(join(artifactDirectory, "result.xcresult"), {
      recursive: true,
    });
    await mkdir(bin);
    await execute("git", ["init", "-b", "main", repository]);
    await execute("git", [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      "https://github.com/example/app.git",
    ]);
    const gitDirectory = await realpath(join(repository, ".git"));
    const xcrun = join(bin, "xcrun");
    await writeFile(
      xcrun,
      `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(invocations)}
case " $* " in
  *" xcodebuild "*) printf started > ${JSON.stringify(buildStarted)}; exec sleep 30 ;;
  *) printf '{}' ;;
esac
`,
    );
    await chmod(xcrun, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    const controller = new AbortController();
    const poll = setInterval(() => {
      void stat(buildStarted)
        .then(() => controller.abort())
        .catch(() => undefined);
    }, 10);
    try {
      const result = (await runIosBuild(
        payload({
          folder: repository,
          gitDirectory,
          expectedOrigin: normalizeGitOrigin(
            "https://github.com/example/app.git",
          ).canonicalOrigin,
          buildId: "build-cancelled",
          artifactDirectory,
          action: "TEST",
          advancedSettings: {
            ...DEFAULT_BUILD_ADVANCED_SETTINGS,
            parseTestResults: true,
          },
        }),
        30_000,
        controller.signal,
        async () => undefined,
      )) as unknown as {
        cancelled: boolean;
        reports: unknown[];
      };

      expect(result).toMatchObject({ cancelled: true, reports: [] });
      expect(await readFile(invocations, "utf8")).not.toContain(
        "xcresulttool get test-results",
      );
    } finally {
      clearInterval(poll);
      process.env.PATH = originalPath;
    }
  });

  test("uploads a build artifact through the control plane", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-build-download-"));
    temporaryDirectories.push(root);
    const artifactDirectory = join(root, "build-1");
    await mkdir(artifactDirectory);
    await writeFile(join(artifactDirectory, "build.log"), "build output");
    let uploaded = "";

    await expect(
      downloadIosBuildArtifact(
        {
          buildId: "build-1",
          artifactDirectory,
          artifactRelativePath: "build.log",
          uploadId: "upload-1",
          codebaseId: "codebase-1",
        },
        30_000,
        new AbortController().signal,
        async () => undefined,
        {
          reportWorktreeActivity: async () => undefined,
          uploadBuildArtifact: async (input) => {
            expect(input).toMatchObject({
              uploadId: "upload-1",
              filename: "build.log",
              contentType: "application/octet-stream",
            });
            uploaded = await readFile(input.path, "utf8");
          },
        },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(uploaded).toBe("build output");
  });

  test("runs hooks in deterministic order, redacts output, and finalizes the raw log artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-build-agent-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const bin = join(root, "bin");
    const builds = join(root, "builds");
    await mkdir(join(repository, "App.xcworkspace"), { recursive: true });
    await mkdir(bin);
    await mkdir(builds);
    await execute("git", ["init", "-b", "main", repository]);
    await execute("git", [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      "https://github.com/example/app.git",
    ]);
    const gitDirectory = await realpath(join(repository, ".git"));
    const xcrun = join(bin, "xcrun");
    await writeFile(
      xcrun,
      "#!/bin/sh\ncase \" $* \" in *\" -showBuildSettings \"*) printf '[]' ;; *) printf 'xcodebuild complete\\n' ;; esac\n",
    );
    await chmod(xcrun, 0o755);
    const originalPath = process.env.PATH;
    const originalSecret = process.env.TEST_API_TOKEN;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.TEST_API_TOKEN = "integration-secret";
    const artifactDirectory = join(builds, "build-ordered");
    const events: Array<{ message: string }> = [];
    const hookSource = (value: string, includeSecret = false) =>
      `import { appendFile } from "node:fs/promises";
export default async function hook(build) {
  await appendFile("hook-order.txt", ${JSON.stringify(`${value}\n`)});
  await appendFile("hook-contexts.jsonl", JSON.stringify(build) + "\\n");
  ${includeSecret ? 'console.log("integration-secret");' : ""}
}`;
    try {
      const result = (await runIosBuild(
        payload({
          folder: repository,
          gitDirectory,
          expectedOrigin: normalizeGitOrigin(
            "https://github.com/example/app.git",
          ).canonicalOrigin,
          branch: "feature/hooks",
          buildId: "build-ordered",
          artifactDirectory,
          scripts: [
            {
              id: "first",
              name: "First",
              preBuildScript: hookSource("pre-first", true),
              postBuildScript: hookSource("post-first"),
              timeoutSeconds: 10,
              failureBehavior: "FAIL_BUILD",
              position: 1,
            },
            {
              id: "second",
              name: "Second",
              preBuildScript: hookSource("pre-second"),
              postBuildScript: hookSource("post-second"),
              timeoutSeconds: 10,
              failureBehavior: "FAIL_BUILD",
              position: 2,
            },
          ],
        }),
        30_000,
        new AbortController().signal,
        async () => undefined,
        {
          reportWorktreeActivity: async () => undefined,
          reportBuildProgress: async () => undefined,
          appendBuildLogs: async (_buildId, batch) => {
            events.push(...batch);
          },
        },
      )) as unknown as {
        exitCode: number | null;
        artifacts: Array<{ kind: string; sizeBytes: number }>;
        scriptExecutions: Array<{ phase: string; position: number }>;
      };

      expect(result.exitCode).toBe(0);
      expect(await readFile(join(repository, "hook-order.txt"), "utf8")).toBe(
        "pre-first\npre-second\npost-second\npost-first\n",
      );
      const contexts = (
        await readFile(join(repository, "hook-contexts.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(contexts[0]).toMatchObject({
        buildId: "build-ordered",
        branch: "feature/hooks",
        action: "BUILD",
        destination: { id: "SIM-1" },
      });
      expect(contexts[2]).toMatchObject({
        buildFolder: artifactDirectory,
        failed: false,
        cancelled: false,
        errorCode: null,
        error: null,
      });
      expect(
        result.scriptExecutions.map(({ phase, position }) => [phase, position]),
      ).toEqual([
        ["PRE_BUILD", 1],
        ["PRE_BUILD", 2],
        ["POST_BUILD", 2],
        ["POST_BUILD", 1],
      ]);
      const rawLog = join(artifactDirectory, "build.log");
      const rawArtifact = result.artifacts.find(
        ({ kind }) => kind === "RAW_LOG",
      );
      expect(rawArtifact?.sizeBytes).toBe((await stat(rawLog)).size);
      expect(await readFile(rawLog, "utf8")).not.toContain(
        "integration-secret",
      );
      expect(events.some(({ message }) => message.includes("[REDACTED]"))).toBe(
        true,
      );
    } finally {
      process.env.PATH = originalPath;
      if (originalSecret === undefined) delete process.env.TEST_API_TOKEN;
      else process.env.TEST_API_TOKEN = originalSecret;
    }
  });
});

describe("iOS archive export artifacts", () => {
  const roots: string[] = [];
  // Bundle metadata is read with plutil, which only exists on macOS. The agent
  // only ever runs there, but the suite itself should stay portable.
  const withPlutil = existsSync("/usr/bin/plutil") ? test : test.skip;

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function workspace(): Promise<{
    artifactDirectory: string;
    archivePath: string;
    exportDirectory: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "ade-export-test-"));
    roots.push(root);
    const artifactDirectory = join(root, "artifacts");
    const archivePath = join(artifactDirectory, "archive.xcarchive");
    const exportDirectory = join(artifactDirectory, "exports", "export-1");
    await mkdir(archivePath, { recursive: true });
    await mkdir(exportDirectory, { recursive: true });
    return { artifactDirectory, archivePath, exportDirectory };
  }

  async function writeArchivePlist(
    archivePath: string,
    properties: Record<string, string>,
  ): Promise<void> {
    const entries = Object.entries(properties)
      .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
      .join("");
    await writeFile(
      join(archivePath, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>ApplicationProperties</key><dict>${entries}</dict></dict></plist>\n`,
    );
  }

  function payload(artifactDirectory: string) {
    return {
      buildId: "build-1",
      exportId: "export-1",
      artifactDirectory,
      archiveRelativePath: "archive.xcarchive",
      settings: { method: "RELEASE_TESTING" },
    } as unknown as Parameters<typeof exportedArtifacts>[0];
  }

  withPlutil(
    "reads application identity from the archive Info.plist",
    async () => {
      const { archivePath } = await workspace();
      await writeArchivePlist(archivePath, {
        CFBundleIdentifier: "com.example.App",
        CFBundleShortVersionString: "2.1.0",
        CFBundleVersion: "417",
        ApplicationPath: "Applications/Example.app",
      });

      await expect(
        archiveApplicationProperties(
          archivePath,
          5_000,
          AbortSignal.timeout(10_000),
        ),
      ).resolves.toEqual({
        bundleIdentifier: "com.example.App",
        bundleShortVersion: "2.1.0",
        bundleVersion: "417",
        applicationName: "Example",
      });
    },
  );

  withPlutil("returns nulls when the archive has no Info.plist", async () => {
    const { archivePath } = await workspace();

    await expect(
      archiveApplicationProperties(
        archivePath,
        5_000,
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toEqual({
      bundleIdentifier: null,
      bundleShortVersion: null,
      bundleVersion: null,
      applicationName: null,
    });
  });

  withPlutil(
    "registers the exported IPA with its bundle metadata",
    async () => {
      const { artifactDirectory, archivePath, exportDirectory } =
        await workspace();
      await writeArchivePlist(archivePath, {
        CFBundleIdentifier: "com.example.App",
        CFBundleShortVersionString: "2.1.0",
        CFBundleVersion: "417",
        ApplicationPath: "Applications/Example.app",
      });
      await writeFile(join(exportDirectory, "Example.ipa"), "package-bytes");
      await writeFile(join(exportDirectory, "ExportOptions.plist"), "<plist/>");

      const artifacts = await exportedArtifacts(
        payload(artifactDirectory),
        exportDirectory,
        archivePath,
        AbortSignal.timeout(10_000),
      );

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({
        kind: "IPA",
        relativePath: "exports/export-1/Example.ipa",
        sizeBytes: "package-bytes".length,
      });
      expect(artifacts[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(artifacts[0]?.metadata).toMatchObject({
        exportId: "export-1",
        exportMethod: "RELEASE_TESTING",
        bundleIdentifier: "com.example.App",
        bundleShortVersion: "2.1.0",
        applicationName: "Example",
      });
    },
  );

  test("reports no artifacts when the export produced no IPA", async () => {
    const { artifactDirectory, archivePath, exportDirectory } =
      await workspace();
    await writeFile(join(exportDirectory, "ExportOptions.plist"), "<plist/>");

    await expect(
      exportedArtifacts(
        payload(artifactDirectory),
        exportDirectory,
        archivePath,
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toEqual([]);
  });
});
