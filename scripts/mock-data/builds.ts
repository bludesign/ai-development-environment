import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo, hoursAgo, minutesAgo } from "./time";

const BUILDS_DIR = "/Users/acme/Repositories/Builds";

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
      destinationJson: JSON.stringify({
        type: "PHYSICAL_DEVICE",
        id: "generic",
        name: "Any iOS Device (arm64)",
      }),
      snapshotJson: JSON.stringify({
        scheme: "AcmeApp",
        configuration: "Release",
      }),
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
            kind: "COVERAGE",
            source: "XCRESULT",
            status: "SUCCEEDED",
            summaryJson: JSON.stringify({
              lineCoverage: 0.82,
              coveredLines: 8420,
              executableLines: 10270,
            }),
            dataJson: JSON.stringify({
              targets: [
                { name: "AcmeApp", lineCoverage: 0.82 },
                { name: "AcmeKit", lineCoverage: 0.91 },
              ],
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
      destinationJson: JSON.stringify({
        type: "SIMULATOR",
        id: "sim-iphone-16",
        name: "iPhone 16 Pro",
      }),
      snapshotJson: JSON.stringify({ scheme: "AcmeApp", testPlan: "AcmeApp" }),
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
            source: "XCRESULT",
            status: "SUCCEEDED",
            summaryJson: JSON.stringify({
              total: 128,
              passed: 125,
              failed: 3,
            }),
            dataJson: JSON.stringify({
              failures: ["testCheckoutFlow", "testSearchDebounce", "testAuthToken"],
            }),
            finishedAt: minutesAgo(44),
          },
        ],
      },
    },
  });
}
