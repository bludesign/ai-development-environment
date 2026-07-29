import type { PrismaClient } from "../../src/generated/prisma/client";

import {
  CHANGED_COVERAGE_FILES,
  COVERAGE_FILES,
  COVERAGE_SUMMARY,
} from "./coverage";
import { ids } from "./ids";
import { daysAgo, hoursAgo, minutesAgo } from "./time";

const BUILDS_DIR = "/Users/acme/Repositories/Builds";
const IOS_HEAD_SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

const ARCHIVE_DESTINATION = {
  type: "PHYSICAL_DEVICE",
  id: "generic",
  name: "Any iOS Device (arm64)",
};

const TEST_DESTINATION = {
  type: "SIMULATOR",
  id: "sim-iphone-16",
  name: "iPhone 16 Pro",
};

/**
 * The build pages read their repository name, branch, commit, scheme and configuration from
 * the nested snapshot BuildsService.startBuild writes (`repository`/`worktree`/`configuration`
 * keys), not from the live relations — a flat `{ scheme, configuration }` object leaves every
 * one of those fields rendering its "—" fallback. Mirrors that shape.
 */
function buildSnapshot(overrides: {
  action: string;
  destination: Record<string, unknown>;
  testPlan?: string;
}) {
  return {
    repository: {
      id: ids.repositories.ios,
      name: "ios-app",
      canonicalOrigin: "github.com/acme/ios-app",
    },
    codebase: {
      id: ids.codebases.ios,
      folder: "/Users/acme/Repositories/ios-app",
    },
    worktree: {
      id: ids.worktrees.iosMain,
      folder: "/Users/acme/Repositories/ios-app",
      branch: "main",
      headSha: IOS_HEAD_SHA,
      codeStateHash: "sha256-ios-main-code-state-0001",
      hasStagedChanges: false,
      hasUnstagedChanges: false,
    },
    agent: {
      id: ids.agents.build,
      name: "Build Mac",
      hostname: "build-mac.local",
    },
    configuration: {
      id: ids.buildConfigurations.release,
      name: "App Store Release",
      iconKey: "rocket",
      source: {
        id: ids.buildSources.ios,
        kind: "WORKSPACE",
        relativePath: "AcmeApp.xcworkspace",
      },
      scheme: "AcmeApp",
      buildConfiguration: "Release",
      action: overrides.action,
      advancedSettings: { codeCoverage: true },
      autoExport: true,
      exportSettings: { method: "APP_STORE_CONNECT" },
      ...(overrides.testPlan ? { testPlan: overrides.testPlan } : {}),
      parse: {
        status: "VALID",
        schemes: ["AcmeApp", "AcmeAppTests"],
        configurations: ["Debug", "Release"],
        testPlans: ["AcmeApp"],
        headSha: IOS_HEAD_SHA,
        xcodeVersion: "16.4",
        parsedAt: hoursAgo(5).toISOString(),
      },
    },
    destination: overrides.destination,
    scripts: [
      {
        id: ids.buildScripts.swiftlint,
        name: "SwiftLint",
        preBuildScript: "swiftlint --strict",
        timeoutSeconds: 300,
        failureBehavior: "FAIL_BUILD",
      },
    ],
    worktreeCoverage: false,
  };
}

/**
 * Report payloads must match the GraphQL shapes in schemas/builds.graphql: `BuildReport.tests`
 * reads `data.tests` as `BuildTestCase`. The coverage report reads `data.files` /
 * `data.changedFiles`, which live in ./coverage so the Playwright worktree stub can build a
 * branch diff out of the same fixture. Both are only surfaced when the report status is READY.
 */
const TEST_SUMMARY = {
  total: 128,
  passed: 124,
  failed: 3,
  skipped: 1,
  expectedFailures: 0,
  unknown: 0,
  durationSeconds: 312.48,
};

const TEST_CASES = [
  {
    identifier: "AcmeAppTests/CheckoutTests/testCheckoutFlow",
    name: "testCheckoutFlow",
    plan: "AcmeApp",
    configuration: "Debug",
    bundle: "AcmeAppTests",
    suite: "CheckoutTests",
    result: "FAILED",
    durationSeconds: 4.82,
    tags: ["checkout", "regression"],
    details: [
      'XCTAssertEqual failed: ("$41.98") is not equal to ("$39.99") — CheckoutTests.swift:142',
    ],
  },
  {
    identifier: "AcmeAppTests/SearchTests/testSearchDebounce",
    name: "testSearchDebounce",
    plan: "AcmeApp",
    configuration: "Debug",
    bundle: "AcmeAppTests",
    suite: "SearchTests",
    result: "FAILED",
    durationSeconds: 2.14,
    tags: ["search"],
    details: [
      "Asynchronous wait failed: Exceeded timeout of 2 seconds — SearchTests.swift:88",
    ],
  },
  {
    identifier: "AcmeKitTests/AuthTests/testAuthToken",
    name: "testAuthToken",
    plan: "AcmeApp",
    configuration: "Debug",
    bundle: "AcmeKitTests",
    suite: "AuthTests",
    result: "FAILED",
    durationSeconds: 0.96,
    tags: ["auth"],
    details: ["XCTAssertNotNil failed — AuthTests.swift:57"],
  },
  {
    identifier: "AcmeAppTests/CheckoutTests/testApplyPromotionCode",
    name: "testApplyPromotionCode",
    plan: "AcmeApp",
    configuration: "Debug",
    bundle: "AcmeAppTests",
    suite: "CheckoutTests",
    result: "PASSED",
    durationSeconds: 1.27,
    tags: ["checkout"],
    details: [],
  },
  {
    identifier: "AcmeAppTests/SearchTests/testSearchRanking",
    name: "testSearchRanking",
    plan: "AcmeApp",
    configuration: "Debug",
    bundle: "AcmeAppTests",
    suite: "SearchTests",
    result: "PASSED",
    durationSeconds: 3.41,
    tags: ["search"],
    details: [],
  },
  {
    identifier: "AcmeKitTests/NetworkTests/testRetryPolicy",
    name: "testRetryPolicy",
    plan: "AcmeApp",
    configuration: "Debug",
    bundle: "AcmeKitTests",
    suite: "NetworkTests",
    result: "PASSED",
    durationSeconds: 5.63,
    tags: ["networking"],
    details: [],
  },
  {
    identifier: "AcmeKitTests/StorageTests/testCacheEvictionUnderPressure",
    name: "testCacheEvictionUnderPressure",
    plan: "AcmeApp",
    configuration: "Debug",
    bundle: "AcmeKitTests",
    suite: "StorageTests",
    result: "SKIPPED",
    durationSeconds: 0,
    tags: ["storage"],
    details: ["Requires a physical device"],
  },
];

/**
 * Older builds behind the two detailed ones below. The Builds table only reads the snapshot,
 * status, action, destination and timestamps, so these carry no artifacts or reports — the
 * detail-page screenshots still point at the two fully-populated builds.
 *
 * None of them is FAILED on purpose: the Action Center index surfaces every FAILED build as a
 * "needs attention" card, so a failed row here would change the sidebar in every other
 * screenshot. CANCELLED gives the list a non-green row without that.
 */
const BUILD_HISTORY: Array<{
  slug: string;
  status: "SUCCEEDED" | "CANCELLED";
  action: "ARCHIVE" | "BUILD" | "TEST";
  startedHoursAgo: number;
  durationMinutes: number;
  errorCode?: string;
  error?: string;
}> = [
  {
    slug: "test-2",
    status: "SUCCEEDED",
    action: "TEST",
    startedHoursAgo: 9,
    durationMinutes: 7,
  },
  {
    slug: "build-1",
    status: "SUCCEEDED",
    action: "BUILD",
    startedHoursAgo: 12,
    durationMinutes: 4,
  },
  {
    slug: "build-2",
    status: "CANCELLED",
    action: "BUILD",
    startedHoursAgo: 27,
    durationMinutes: 2,
    errorCode: "CANCELLED",
    error: "Cancelled from the Builds page",
  },
  {
    slug: "build-3",
    status: "SUCCEEDED",
    action: "BUILD",
    startedHoursAgo: 28,
    durationMinutes: 5,
  },
  {
    slug: "test-3",
    status: "CANCELLED",
    action: "TEST",
    startedHoursAgo: 31,
    durationMinutes: 1,
    errorCode: "CANCELLED",
    error: "Cancelled from the Builds page",
  },
  {
    slug: "archive-2",
    status: "SUCCEEDED",
    action: "ARCHIVE",
    startedHoursAgo: 52,
    durationMinutes: 58,
  },
  {
    slug: "test-4",
    status: "SUCCEEDED",
    action: "TEST",
    startedHoursAgo: 54,
    durationMinutes: 6,
  },
  {
    slug: "build-4",
    status: "SUCCEEDED",
    action: "BUILD",
    startedHoursAgo: 76,
    durationMinutes: 4,
  },
];

const COMMAND_SUMMARIES: Record<"ARCHIVE" | "BUILD" | "TEST", string> = {
  ARCHIVE:
    "xcodebuild archive -workspace AcmeApp.xcworkspace -scheme AcmeApp -configuration Release",
  BUILD:
    "xcodebuild build -workspace AcmeApp.xcworkspace -scheme AcmeApp -configuration Debug",
  TEST: "xcodebuild test -workspace AcmeApp.xcworkspace -scheme AcmeApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro'",
};

export async function seedBuilds(prisma: PrismaClient): Promise<void> {
  await prisma.codebaseProject.create({
    data: {
      id: ids.buildProjects.ios,
      repositoryId: ids.repositories.ios,
      type: "IOS_APP",
      createdAt: daysAgo(110),
    },
  });

  await prisma.buildSource.create({
    data: {
      id: ids.buildSources.ios,
      projectId: ids.buildProjects.ios,
      kind: "WORKSPACE",
      relativePath: "AcmeApp.xcworkspace",
      createdAt: daysAgo(110),
    },
  });

  await prisma.buildSourceObservation.create({
    data: {
      id: "observation-ios-app",
      sourceId: ids.buildSources.ios,
      scopeKey: `codebase:${ids.codebases.ios}`,
      codebaseId: ids.codebases.ios,
      status: "VALID",
      schemesJson: JSON.stringify(["AcmeApp", "AcmeAppTests"]),
      configurationsJson: JSON.stringify(["Debug", "Release"]),
      testPlansJson: JSON.stringify(["AcmeApp"]),
      headSha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
      xcodeVersion: "16.4",
      lastParseAttemptAt: hoursAgo(5),
      lastParsedAt: hoursAgo(5),
    },
  });

  await prisma.buildConfiguration.create({
    data: {
      id: ids.buildConfigurations.release,
      projectId: ids.buildProjects.ios,
      sourceId: ids.buildSources.ios,
      name: "App Store Release",
      iconKey: "rocket",
      scheme: "AcmeApp",
      buildConfiguration: "Release",
      defaultAction: "ARCHIVE",
      autoExport: true,
      exportSettingsJson: JSON.stringify({ method: "APP_STORE_CONNECT" }),
      createdAt: daysAgo(60),
    },
  });

  await prisma.buildScript.create({
    data: {
      id: ids.buildScripts.swiftlint,
      name: "SwiftLint",
      preBuildScript: "swiftlint --strict",
      enabledByDefault: true,
      timeoutSeconds: 300,
      failureBehavior: "FAIL_BUILD",
      createdAt: daysAgo(60),
    },
  });

  await prisma.codebaseRepositoryBuildScript.create({
    data: {
      repositoryId: ids.repositories.ios,
      scriptId: ids.buildScripts.swiftlint,
      position: 0,
    },
  });

  // Successful archive build with artifacts, a report, a deployment and an export.
  await prisma.build.create({
    data: {
      id: ids.builds.archive,
      requestKey: "build-request-archive-1",
      requestId: "req-archive-1",
      agentId: ids.agents.build,
      codebaseId: ids.codebases.ios,
      worktreeId: ids.worktrees.iosMain,
      configurationId: ids.buildConfigurations.release,
      status: "SUCCEEDED",
      action: "ARCHIVE",
      destinationType: "PHYSICAL_DEVICE",
      destinationJson: JSON.stringify(ARCHIVE_DESTINATION),
      snapshotJson: JSON.stringify(
        buildSnapshot({ action: "ARCHIVE", destination: ARCHIVE_DESTINATION }),
      ),
      commandSummary:
        "xcodebuild archive -workspace AcmeApp.xcworkspace -scheme AcmeApp -configuration Release",
      artifactDirectory: `${BUILDS_DIR}/${ids.builds.archive}`,
      createdAt: hoursAgo(4),
      startedAt: hoursAgo(4),
      finishedAt: hoursAgo(3),
      artifacts: {
        create: [
          {
            id: "artifact-archive-xcarchive",
            kind: "ARCHIVE",
            relativePath: "AcmeApp.xcarchive",
            sizeBytes: 184_320_000,
            createdAt: hoursAgo(3),
          },
          {
            id: "artifact-archive-log",
            kind: "LOG",
            relativePath: "build.log",
            sizeBytes: 512_000,
            createdAt: hoursAgo(3),
          },
        ],
      },
      reports: {
        create: [
          {
            id: "report-archive-coverage",
            kind: "CODE_COVERAGE",
            // What BuildsService records for every coverage report a build produces, and what
            // `worktreeCoverageReports` filters on — the source the worktree coverage card and
            // the changes page's coverage picker both read.
            source: "WORKTREE",
            status: "READY",
            summaryJson: JSON.stringify(COVERAGE_SUMMARY),
            dataJson: JSON.stringify({
              files: COVERAGE_FILES,
              changedFiles: CHANGED_COVERAGE_FILES,
            }),
            finishedAt: hoursAgo(3),
          },
        ],
      },
      scriptExecutions: {
        create: [
          {
            id: "script-exec-archive-swiftlint",
            phase: "PRE_BUILD",
            position: 0,
            nameSnapshot: "SwiftLint",
            sourceSnapshot: "swiftlint --strict",
            timeoutSeconds: 300,
            failureBehavior: "FAIL_BUILD",
            status: "SUCCEEDED",
            exitCode: 0,
            durationMs: 4200,
            createdAt: hoursAgo(4),
          },
        ],
      },
      logChunks: {
        create: [
          {
            id: "log-archive-1",
            scope: "BUILD",
            scopeId: ids.builds.archive,
            sequence: 1,
            phase: "BUILD",
            stream: "STDOUT",
            dataBase64: Buffer.from("=== BUILD TARGET AcmeApp ===\n").toString(
              "base64",
            ),
            byteLength: 30,
            createdAt: hoursAgo(4),
          },
          {
            id: "log-archive-2",
            scope: "BUILD",
            scopeId: ids.builds.archive,
            sequence: 2,
            phase: "BUILD",
            stream: "STDOUT",
            dataBase64: Buffer.from("** ARCHIVE SUCCEEDED **\n").toString(
              "base64",
            ),
            byteLength: 24,
            createdAt: hoursAgo(3),
          },
        ],
      },
      exports: {
        create: [
          {
            id: "export-archive-1",
            requestId: "req-export-1",
            status: "SUCCEEDED",
            settingsSnapshotJson: JSON.stringify({
              method: "APP_STORE_CONNECT",
            }),
            commandSummary: "xcodebuild -exportArchive -exportOptionsPlist …",
            outputRelativePath: "export/AcmeApp.ipa",
            createdAt: hoursAgo(3),
            startedAt: hoursAgo(3),
            finishedAt: hoursAgo(3),
          },
        ],
      },
      deployments: {
        create: [
          {
            id: "deployment-archive-1",
            batchId: "batch-deploy-1",
            requestId: "req-deploy-1",
            destinationJson: JSON.stringify({
              type: "APP_STORE_CONNECT",
              name: "TestFlight",
            }),
            destinationKey: "app-store-connect:testflight",
            status: "SUCCEEDED",
            commandSummary: "xcrun altool --upload-app …",
            createdAt: hoursAgo(2),
            startedAt: hoursAgo(2),
            finishedAt: hoursAgo(2),
          },
        ],
      },
    },
  });

  // Failed test build.
  await prisma.build.create({
    data: {
      id: ids.builds.test,
      requestKey: "build-request-test-1",
      requestId: "req-test-1",
      agentId: ids.agents.build,
      codebaseId: ids.codebases.ios,
      worktreeId: ids.worktrees.iosMain,
      configurationId: ids.buildConfigurations.release,
      status: "FAILED",
      action: "TEST",
      destinationType: "SIMULATOR",
      destinationJson: JSON.stringify(TEST_DESTINATION),
      snapshotJson: JSON.stringify(
        buildSnapshot({
          action: "TEST",
          destination: TEST_DESTINATION,
          testPlan: "AcmeApp",
        }),
      ),
      commandSummary:
        "xcodebuild test -workspace AcmeApp.xcworkspace -scheme AcmeApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro'",
      artifactDirectory: `${BUILDS_DIR}/${ids.builds.test}`,
      errorCode: "TEST_FAILURES",
      error: "3 tests failed in AcmeAppTests",
      createdAt: minutesAgo(50),
      startedAt: minutesAgo(50),
      finishedAt: minutesAgo(44),
      reports: {
        create: [
          {
            id: "report-test-results",
            kind: "TEST_RESULTS",
            source: "AUTOMATIC",
            status: "READY",
            summaryJson: JSON.stringify(TEST_SUMMARY),
            dataJson: JSON.stringify({ tests: TEST_CASES }),
            finishedAt: minutesAgo(44),
          },
        ],
      },
    },
  });

  for (const build of BUILD_HISTORY) {
    const id = `build-ios-${build.slug}`;
    const destination =
      build.action === "TEST" ? TEST_DESTINATION : ARCHIVE_DESTINATION;
    const startedAt = hoursAgo(build.startedHoursAgo);
    await prisma.build.create({
      data: {
        id,
        requestKey: `build-request-${build.slug}`,
        requestId: `req-${build.slug}`,
        agentId: ids.agents.build,
        codebaseId: ids.codebases.ios,
        worktreeId: ids.worktrees.iosMain,
        configurationId: ids.buildConfigurations.release,
        status: build.status,
        action: build.action,
        destinationType: destination.type,
        destinationJson: JSON.stringify(destination),
        snapshotJson: JSON.stringify(
          buildSnapshot({
            action: build.action,
            destination,
            ...(build.action === "TEST" ? { testPlan: "AcmeApp" } : {}),
          }),
        ),
        commandSummary: COMMAND_SUMMARIES[build.action],
        artifactDirectory: `${BUILDS_DIR}/${id}`,
        errorCode: build.errorCode ?? null,
        error: build.error ?? null,
        createdAt: startedAt,
        startedAt,
        finishedAt: minutesAgo(
          build.startedHoursAgo * 60 - build.durationMinutes,
        ),
      },
    });
  }
}
