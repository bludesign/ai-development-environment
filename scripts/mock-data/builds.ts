import type { PrismaClient } from "../../src/generated/prisma/client";

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
 * reads `data.tests` as `BuildTestCase`, and the coverage report reads `data.files` /
 * `data.changedFiles`. Both are only surfaced when the report status is READY.
 */
/**
 * Every file in the report, as `path → [coveredLines, executableLines]`. Coverage ratios and
 * the report summary are derived from these numbers below so the tiles, the per-file rows and
 * the file count can never drift apart.
 */
const COVERAGE_LINES: Record<string, [number, number]> = {
  "AcmeApp/AppDelegate.swift": [74, 132],
  "AcmeApp/Checkout/CheckoutViewModel.swift": [412, 468],
  "AcmeApp/Checkout/CheckoutSummaryView.swift": [52, 74],
  "AcmeApp/Checkout/PaymentMethodPicker.swift": [188, 232],
  "AcmeApp/Checkout/PromotionCodeField.swift": [96, 118],
  "AcmeApp/Checkout/OrderConfirmationView.swift": [134, 176],
  "AcmeApp/Search/SearchCoordinator.swift": [286, 374],
  "AcmeApp/Search/SearchResultsView.swift": [214, 268],
  "AcmeApp/Search/RecentSearchesStore.swift": [122, 138],
  "AcmeApp/Catalog/CatalogListViewModel.swift": [346, 402],
  "AcmeApp/Catalog/ProductDetailView.swift": [258, 336],
  "AcmeApp/Profile/ProfileSettingsView.swift": [166, 244],
  "AcmeApp/Profile/NotificationPreferences.swift": [88, 104],
  "AcmeApp/Onboarding/WelcomeFlowView.swift": [72, 148],
  "AcmeKit/Auth/AuthTokenStore.swift": [318, 332],
  "AcmeKit/Auth/DeviceAuthorizationClient.swift": [204, 226],
  "AcmeKit/Auth/KeychainAdapter.swift": [142, 164],
  "AcmeKit/Networking/NetworkClient.swift": [504, 548],
  "AcmeKit/Networking/RequestRetryPolicy.swift": [176, 192],
  "AcmeKit/Networking/MultipartEncoder.swift": [118, 158],
  "AcmeKit/Storage/CacheStore.swift": [196, 244],
  "AcmeKit/Storage/MigrationRunner.swift": [154, 218],
  "AcmeKit/Analytics/EventDispatcher.swift": [232, 264],
  "AcmeKit/Analytics/SessionTracker.swift": [108, 152],
};

/** Which of the above the build's diff touched, and how the diff itself was covered. */
const CHANGED_LINES: Record<string, ["MODIFIED" | "ADDED", number, number]> = {
  "AcmeApp/Search/SearchCoordinator.swift": ["MODIFIED", 148, 176],
  "AcmeApp/Search/SearchResultsView.swift": ["MODIFIED", 96, 112],
  "AcmeApp/Search/RecentSearchesStore.swift": ["ADDED", 64, 71],
  "AcmeKit/Auth/AuthTokenStore.swift": ["MODIFIED", 212, 236],
  "AcmeKit/Auth/DeviceAuthorizationClient.swift": ["ADDED", 118, 142],
  "AcmeKit/Auth/KeychainAdapter.swift": ["MODIFIED", 74, 88],
  "AcmeApp/Checkout/CheckoutSummaryView.swift": ["ADDED", 52, 74],
  "AcmeApp/Checkout/CheckoutViewModel.swift": ["MODIFIED", 186, 204],
  "AcmeApp/Checkout/PaymentMethodPicker.swift": ["MODIFIED", 92, 118],
  "AcmeApp/Checkout/PromotionCodeField.swift": ["ADDED", 48, 62],
  "AcmeApp/Checkout/OrderConfirmationView.swift": ["ADDED", 66, 98],
  "AcmeApp/Catalog/CatalogListViewModel.swift": ["MODIFIED", 138, 152],
  "AcmeApp/Catalog/ProductDetailView.swift": ["MODIFIED", 104, 148],
  "AcmeApp/Profile/ProfileSettingsView.swift": ["MODIFIED", 58, 96],
  "AcmeApp/Profile/NotificationPreferences.swift": ["ADDED", 42, 51],
  "AcmeApp/Onboarding/WelcomeFlowView.swift": ["MODIFIED", 24, 68],
  "AcmeKit/Networking/RequestRetryPolicy.swift": ["MODIFIED", 82, 90],
  "AcmeKit/Networking/MultipartEncoder.swift": ["ADDED", 56, 84],
  "AcmeKit/Storage/MigrationRunner.swift": ["MODIFIED", 71, 112],
  "AcmeKit/Analytics/SessionTracker.swift": ["ADDED", 38, 74],
};

/** Ratios are rounded to four places, the precision a real xccov export reports. */
const ratio = (covered: number, executable: number): number =>
  executable === 0 ? 0 : Math.round((covered / executable) * 10_000) / 10_000;

const COVERAGE_FILES = Object.entries(COVERAGE_LINES).map(
  ([path, [coveredLines, executableLines]]) => ({
    target: path.split("/")[0]!,
    name: path.split("/").at(-1)!,
    path,
    coveredLines,
    executableLines,
    lineCoverage: ratio(coveredLines, executableLines),
  }),
);

const CHANGED_COVERAGE_FILES = Object.entries(CHANGED_LINES).map(
  ([path, [changeType, changedCoveredLines, changedExecutableLines]]) => ({
    path,
    changeType,
    changedCoveredLines,
    changedExecutableLines,
    changedLineCoverage: ratio(changedCoveredLines, changedExecutableLines),
  }),
);

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

const COVERAGE_SUMMARY = (() => {
  const coveredLines = sum(COVERAGE_FILES.map((file) => file.coveredLines));
  const executableLines = sum(
    COVERAGE_FILES.map((file) => file.executableLines),
  );
  const changedCoveredLines = sum(
    CHANGED_COVERAGE_FILES.map((file) => file.changedCoveredLines),
  );
  const changedExecutableLines = sum(
    CHANGED_COVERAGE_FILES.map((file) => file.changedExecutableLines),
  );
  return {
    coveredLines,
    executableLines,
    lineCoverage: ratio(coveredLines, executableLines),
    targetCount: new Set(COVERAGE_FILES.map((file) => file.target)).size,
    fileCount: COVERAGE_FILES.length,
    changedCoveredLines,
    changedExecutableLines,
    changedLineCoverage: ratio(changedCoveredLines, changedExecutableLines),
  };
})();

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
      "XCTAssertEqual failed: (\"$41.98\") is not equal to (\"$39.99\") — CheckoutTests.swift:142",
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
            source: "AUTOMATIC",
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
}
