import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
const cachedArtifact = vi.hoisted(() => vi.fn());
vi.mock("./artifact-cache", () => ({ cachedArtifact }));

import {
  IOS_AGENT_RUN_DESTINATIONS_JOB_KIND,
  IOS_ARTIFACT_TRANSFER_UPLOAD_JOB_KIND,
  IOS_BUILD_JOB_KIND,
  IOS_BUILD_DELETE_JOB_KIND,
  IOS_DESTINATIONS_JOB_KIND,
  IOS_DEPLOY_JOB_KIND,
  IOS_REMOTE_DEPLOY_JOB_KIND,
  IOS_RUN_DESTINATIONS_JOB_KIND,
  XCODE_MULTIPLATFORM_BUILD_CAPABILITY,
  parseBuildJobPayload,
  type BuildDestination,
} from "@ai-development-environment/agent-contract/builds";
import { COVERAGE_IMPORT_JOB_KIND } from "@ai-development-environment/agent-contract/coverage";
import {
  BUILDS_CHANGED_TOPIC,
  agentEventBus,
  buildLogChunkTopic,
  buildTopic,
  type AgentControlService,
} from "@/services/agent-control";

import { BuildsService } from "./builds.service";
import type { TelemetryService } from "@/services/telemetry";

const destination: BuildDestination = {
  type: "SIMULATOR",
  id: "SIM-1",
  name: "iPhone 17 Pro",
  platform: "iOS Simulator",
  osVersion: "26.0",
  state: "Booted",
};

function worktree() {
  return {
    id: "worktree-1",
    codebaseId: "codebase-1",
    folder: "/agent/repository",
    gitDirectory: "/agent/repository/.git",
    branch: "main",
    headSha: "abc123",
    codeStateHash: "state-before-build",
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    missingAt: null,
    availability: "AVAILABLE",
    codebase: {
      id: "codebase-1",
      agentId: "agent-1",
      folder: "/agent/repository",
      repositoryId: "repository-1",
      agent: {
        id: "agent-1",
        name: "Builder",
        hostname: "builder.local",
        osVersion: "macOS 26.0",
        architecture: "arm64",
        capabilitiesJson: JSON.stringify([
          IOS_BUILD_JOB_KIND,
          IOS_DESTINATIONS_JOB_KIND,
          IOS_RUN_DESTINATIONS_JOB_KIND,
        ]),
        lastSeenAt: new Date(),
        disconnectedAt: null,
        baseRepoDirectory: "/agent/repositories",
        buildsDirectory: null,
        defaultBuildsDirectory: "/legacy/application-support/builds",
      },
      repository: {
        id: "repository-1",
        name: "App",
        canonicalOrigin: "github.com/example/app",
      },
    },
  };
}

function configuration() {
  return {
    id: "configuration-1",
    projectId: "project-1",
    sourceId: "source-1",
    name: "Debug",
    iconKey: "hammer",
    scheme: "App",
    buildConfiguration: "Debug",
    defaultAction: "BUILD",
    advancedSettingsJson: "{}",
    source: {
      id: "source-1",
      kind: "WORKSPACE",
      relativePath: "App.xcworkspace",
      project: { id: "project-1", repositoryId: "repository-1" },
    },
  };
}

function observation() {
  return {
    id: "observation-1",
    status: "VALID",
    schemesJson: '["App"]',
    configurationsJson: '["Debug","Release"]',
    testPlansJson: '["Integration"]',
    headSha: "abc123",
    xcodeVersion: "Xcode 26.0",
    lastParsedAt: new Date("2026-07-18T00:00:00Z"),
  };
}

function control(
  createJob = vi.fn().mockResolvedValue({ id: "job-1" }),
  cancelJob = vi.fn().mockResolvedValue({}),
) {
  return {
    registerCompletionHandler: vi.fn(),
    createJob,
    cancelJob,
  } as unknown as AgentControlService;
}

describe("BuildsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cachedArtifact.mockResolvedValue(null);
  });

  test("updates the shared iOS project destination default and rejects non-device destinations", async () => {
    const update = vi.fn().mockResolvedValue({ repositoryId: "repository-1" });
    const stored = {
      id: "project-1",
      defaultDestinationType: "PHYSICAL_DEVICE",
    };
    getPrismaClient.mockResolvedValue({ codebaseProject: { update } });
    const service = new BuildsService(control());
    const project = vi
      .spyOn(service, "repositoryProject")
      .mockResolvedValue(stored as never);
    const publish = vi.spyOn(agentEventBus, "publish");

    await expect(
      service.updateProject("project-1", "PHYSICAL_DEVICE"),
    ).resolves.toEqual(stored);
    expect(update).toHaveBeenCalledWith({
      where: { id: "project-1", type: "IOS_APP" },
      data: { defaultDestinationType: "PHYSICAL_DEVICE" },
    });
    expect(project).toHaveBeenCalledWith("repository-1");
    expect(publish).toHaveBeenCalled();

    update.mockClear();
    await expect(service.updateProject("project-1", "HOST")).rejects.toThrow(
      "SIMULATOR or PHYSICAL_DEVICE",
    );
    expect(update).not.toHaveBeenCalled();
    publish.mockRestore();
  });

  test("orders run agents and explains cross-agent eligibility", async () => {
    const agent = (
      id: string,
      capabilities: string[],
      overrides: Record<string, unknown> = {},
    ) => ({
      id,
      name: id,
      hostname: `${id}.local`,
      osVersion: "macOS 26.0",
      architecture: "arm64",
      capabilitiesJson: JSON.stringify(capabilities),
      lastSeenAt: new Date(),
      disconnectedAt: null,
      ...overrides,
    });
    const source = agent("source", [
      IOS_RUN_DESTINATIONS_JOB_KIND,
      IOS_DEPLOY_JOB_KIND,
      IOS_ARTIFACT_TRANSFER_UPLOAD_JOB_KIND,
    ]);
    const targetCapabilities = [
      IOS_AGENT_RUN_DESTINATIONS_JOB_KIND,
      IOS_REMOTE_DEPLOY_JOB_KIND,
    ];
    const agents = [
      agent("eligible", targetCapabilities),
      agent("offline", targetCapabilities, {
        lastSeenAt: new Date(Date.now() - 60 * 60_000),
      }),
      agent("outdated", []),
      source,
    ];
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn().mockResolvedValue({
          id: "build-1",
          status: "SUCCEEDED",
          agentId: source.id,
          agent: source,
          destinationType: "SIMULATOR",
          artifacts: [
            {
              id: "artifact-1",
              kind: "RUNNABLE_APP",
              metadataJson: JSON.stringify({ architectures: ["arm64"] }),
            },
          ],
          worktree: null,
        }),
      },
      agent: { findMany: vi.fn().mockResolvedValue(agents) },
    });

    const options = await new BuildsService(control()).runAgentsForBuild(
      "build-1",
    );

    expect(options[0]).toMatchObject({
      agent: { id: "source" },
      isBuildAgent: true,
      available: true,
    });
    expect(
      options.find((option) => option.agent.id === "eligible"),
    ).toMatchObject({ available: true, unavailableReason: null });
    expect(
      options.find((option) => option.agent.id === "offline"),
    ).toMatchObject({ available: false, unavailableReason: "OFFLINE" });
    expect(
      options.find((option) => option.agent.id === "outdated"),
    ).toMatchObject({
      available: false,
      unavailableReason: "AGENT_UPDATE_REQUIRED",
    });

    source.lastSeenAt = new Date(Date.now() - 60 * 60_000);
    const coldOptions = await new BuildsService(control()).runAgentsForBuild(
      "build-1",
    );
    expect(
      coldOptions.find((option) => option.agent.id === "eligible"),
    ).toMatchObject({
      available: false,
      unavailableReason: "BUILD_AGENT_UNAVAILABLE",
    });
    cachedArtifact.mockResolvedValue({ path: "/cache/artifact" });
    const cachedOptions = await new BuildsService(control()).runAgentsForBuild(
      "build-1",
    );
    expect(
      cachedOptions.find((option) => option.agent.id === "eligible"),
    ).toMatchObject({ available: true, unavailableReason: null });
  });

  test("queues completed build folder deletion and removes its record", async () => {
    const artifactDirectory = "/agent/builds/build-1";
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const createJob = vi.fn().mockResolvedValue({ id: "delete-job" });
    getPrismaClient.mockResolvedValue({
      build: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "build-1",
            status: "SUCCEEDED",
            artifactDirectory,
            agentId: "agent-1",
            agent: {
              capabilitiesJson: JSON.stringify([IOS_BUILD_DELETE_JOB_KIND]),
            },
            codebaseId: "codebase-1",
            worktreeId: "worktree-1",
            deployments: [],
            exports: [],
          },
        ]),
        deleteMany,
      },
    });
    const service = new BuildsService(control(createJob));

    await expect(service.deleteBuilds(["build-1", "build-1"])).resolves.toBe(1);
    expect(createJob).toHaveBeenCalledWith({
      agentId: "agent-1",
      codebaseId: "codebase-1",
      worktreeId: "worktree-1",
      kind: IOS_BUILD_DELETE_JOB_KIND,
      payload: {
        buildId: "build-1",
        artifactDirectory,
        codebaseId: "codebase-1",
      },
      idempotencyKey: "ios:build:delete:build-1",
      timeoutSeconds: 300,
      visibility: "SYSTEM",
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["build-1"] } },
    });
  });

  test("publishes the root field expected by each build subscription", async () => {
    const publish = vi.spyOn(agentEventBus, "publish");
    getPrismaClient.mockResolvedValue({
      build: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "build-1",
            status: "SUCCEEDED",
            artifactDirectory: "/agent/builds/build-1",
            agentId: null,
            agent: null,
            codebaseId: null,
            worktreeId: null,
            deployments: [],
            exports: [],
          },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });

    await new BuildsService(control()).deleteBuilds(["build-1"]);

    expect(publish).toHaveBeenCalledWith(buildTopic("build-1"), {
      buildChanged: { id: "build-1" },
    });
    expect(publish).toHaveBeenCalledWith(BUILDS_CHANGED_TOPIC, {
      buildsChanged: { id: "build-1" },
    });
    publish.mockRestore();
  });

  test("rejects deletion while a deployment or export is active", async () => {
    const deleteMany = vi.fn();
    const createJob = vi.fn();
    getPrismaClient.mockResolvedValue({
      build: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "build-1",
            status: "SUCCEEDED",
            artifactDirectory: "/agent/builds/build-1",
            agentId: "agent-1",
            agent: {
              capabilitiesJson: JSON.stringify([IOS_BUILD_DELETE_JOB_KIND]),
            },
            codebaseId: "codebase-1",
            worktreeId: "worktree-1",
            deployments: [{ id: "deployment-1" }],
            exports: [],
          },
        ]),
        deleteMany,
      },
    });

    await expect(
      new BuildsService(control(createJob)).deleteBuilds(["build-1"]),
    ).rejects.toThrow("running deployments or exports");
    expect(createJob).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  test("returns an idempotent start without queueing another build", async () => {
    const existing = { id: "build-existing", status: "RUNNING" };
    const findUnique = vi.fn().mockResolvedValue(existing);
    getPrismaClient.mockResolvedValue({ build: { findUnique } });
    const createJob = vi.fn();
    const service = new BuildsService(control(createJob));

    await expect(
      service.startBuild({
        worktreeId: "worktree-1",
        configurationId: "configuration-1",
        destination,
        requestId: "request-1",
      }),
    ).resolves.toBe(existing);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestKey: "worktree-1:request-1" },
      }),
    );
    expect(createJob).not.toHaveBeenCalled();
  });

  test("requires a report-capable agent for worktree coverage", async () => {
    const legacyWorktree = {
      ...worktree(),
      baseBranchOverride: null,
      codebase: { ...worktree().codebase, defaultBranch: "main" },
    };
    getPrismaClient.mockResolvedValue({
      build: { findUnique: vi.fn().mockResolvedValue(null) },
      worktree: { findUnique: vi.fn().mockResolvedValue(legacyWorktree) },
    });
    const createJob = vi.fn();

    await expect(
      new BuildsService(control(createJob)).startWorktreeCoverage({
        worktreeId: "worktree-1",
        configurationId: "configuration-1",
        destination,
        requestId: "coverage-1",
      }),
    ).rejects.toThrow("updated for worktree coverage");
    expect(createJob).not.toHaveBeenCalled();
  });

  test("replays accepted coverage before checking the current base branch", async () => {
    const accepted = { id: "build-1", status: "RUNNING" };
    const findWorktree = vi.fn().mockResolvedValue({
      ...worktree(),
      baseBranchOverride: null,
      codebase: { ...worktree().codebase, defaultBranch: null },
    });
    getPrismaClient.mockResolvedValue({
      build: { findUnique: vi.fn().mockResolvedValue(accepted) },
      worktree: { findUnique: findWorktree },
    });
    const createJob = vi.fn();

    await expect(
      new BuildsService(control(createJob)).startWorktreeCoverage({
        worktreeId: "worktree-1",
        configurationId: "configuration-1",
        destination,
        requestId: "coverage-1",
      }),
    ).resolves.toBe(accepted);
    expect(findWorktree).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  test("bounds worktree coverage history and excludes report payloads", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    getPrismaClient.mockResolvedValue({ buildReport: { findMany } });

    await new BuildsService(control()).coverageHistory("worktree-1");

    const query = findMany.mock.calls[0]![0];
    expect(query).toMatchObject({
      where: {
        kind: "CODE_COVERAGE",
        source: "WORKTREE",
        build: { worktreeId: "worktree-1" },
      },
      take: 50,
      select: {
        summaryJson: true,
        build: { select: { artifacts: expect.any(Object) } },
      },
    });
    expect(query.select).not.toHaveProperty("dataJson");
    expect(query).not.toHaveProperty("include");
  });

  test("does not materialize reports for build-list queries", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    getPrismaClient.mockResolvedValue({ build: { findMany } });

    await new BuildsService(control()).builds();

    expect(findMany.mock.calls[0]![0].include).not.toHaveProperty("reports");
  });

  test("rebuilds with the original destination and selected settings", async () => {
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn().mockResolvedValue({
          worktreeId: "worktree-1",
          configurationId: "configuration-1",
          destinationJson: JSON.stringify(destination),
          action: "TEST",
          snapshotJson: JSON.stringify({
            worktree: { id: "worktree-snapshot" },
            server: {
              selectedUrlKind: "PROXY",
              selectedBaseUrl: "https://old.ts.net",
            },
            configuration: {
              id: "configuration-snapshot",
              advancedSettings: {
                testPlan: "Integration",
                enableCodeCoverage: true,
              },
            },
            scripts: [{ id: "script-1" }, { id: "script-2" }],
          }),
        }),
      },
    });
    const service = new BuildsService(control());
    const startBuild = vi
      .spyOn(service, "startBuild")
      .mockResolvedValue({ id: "build-rebuilt" } as never);

    await expect(
      service.rebuildBuild("build-1", "rebuild-request"),
    ).resolves.toEqual({ id: "build-rebuilt" });
    expect(startBuild).toHaveBeenCalledWith({
      worktreeId: "worktree-1",
      configurationId: "configuration-1",
      destination,
      scriptIds: ["script-1", "script-2"],
      action: "TEST",
      advancedSettings: {
        testPlan: "Integration",
        enableCodeCoverage: true,
      },
      exportWhenComplete: false,
      requestId: "rebuild-request",
      serverUrlKind: "PROXY",
    });
  });

  test("rebuilds a legacy iOS snapshot after its preset becomes tvOS-only", async () => {
    const captured = {
      source: { kind: "PROJECT", relativePath: "Original.xcodeproj" },
      scheme: "Original",
      buildConfiguration: "Release",
    };
    const createJob = vi.fn().mockResolvedValue({ id: "rebuilt-job" });
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn(({ where }) =>
          where.id === "original-build"
            ? {
                worktreeId: "worktree-1",
                configurationId: "configuration-1",
                destinationJson: JSON.stringify(destination),
                action: "BUILD",
                snapshotJson: JSON.stringify({ configuration: captured }),
              }
            : null,
        ),
        create: vi.fn(),
        update: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "rebuilt" }),
      },
      worktree: { findUnique: vi.fn().mockResolvedValue(worktree()) },
      buildConfiguration: {
        findUnique: vi.fn().mockResolvedValue({
          ...configuration(),
          platformConfigurationsJson: JSON.stringify([{ platform: "TVOS" }]),
        }),
      },
      codebaseRepositoryBuildScript: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    await expect(
      new BuildsService(control(createJob)).rebuildBuild(
        "original-build",
        "rebuild-request",
      ),
    ).resolves.toEqual({ id: "rebuilt" });
    expect(createJob.mock.calls[0]?.[0].payload).toMatchObject({
      source: captured.source,
      scheme: captured.scheme,
      configuration: captured.buildConfiguration,
      destination,
    });
  });

  test("queues a generic simulator build from saved settings without reparsing", async () => {
    const buildCreate = vi.fn().mockResolvedValue({ id: "build-1" });
    const buildUpdate = vi.fn().mockResolvedValue({ id: "build-1" });
    const createJob = vi.fn().mockResolvedValue({ id: "build-job" });
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: buildCreate,
        update: buildUpdate,
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ id: "build-1", status: "QUEUED" }),
      },
      worktree: { findUnique: vi.fn().mockResolvedValue(worktree()) },
      buildConfiguration: {
        findUnique: vi.fn().mockResolvedValue(configuration()),
      },
      buildSourceObservation: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      codebaseRepositoryBuildScript: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = new BuildsService(control(createJob));

    await expect(
      service.startBuild({
        worktreeId: "worktree-1",
        configurationId: "configuration-1",
        destination: {
          type: "SIMULATOR",
          id: "generic-ios-simulator",
          name: "Any iOS Simulator",
          platform: "iOS Simulator",
          osVersion: null,
          state: null,
          generic: true,
        },
        action: "BUILD",
        requestId: "queued-generic-build",
      }),
    ).resolves.toMatchObject({ status: "QUEUED" });

    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: IOS_BUILD_JOB_KIND,
        payload: expect.objectContaining({
          branch: "main",
          derivedDataPath:
            "/agent/repositories/Builds/.worktree-derived-data/worktree-1",
          destination: expect.objectContaining({
            id: "generic-ios-simulator",
            generic: true,
          }),
        }),
      }),
    );
    const data = buildCreate.mock.calls[0]![0].data;
    expect(data.commandSummary).toContain(
      '-destination "generic/platform=iOS Simulator"',
    );
    expect(JSON.parse(data.snapshotJson).server).toMatchObject({
      selectedUrlKind: "LOCAL",
      selectedBaseUrl: "http://127.0.0.1:3000",
      proxyBaseUrl: "https://aide.example.ts.net",
    });
    expect(createJob.mock.calls[0]![0].payload.server).toEqual(
      JSON.parse(data.snapshotJson).server,
    );
    expect(createJob.mock.calls[0]![0].payload.endpointPaths).toEqual(
      JSON.parse(data.snapshotJson).endpointPaths,
    );
    expect(
      JSON.stringify(createJob.mock.calls[0]![0].payload.endpointPaths),
    ).not.toMatch(/sse|mcp|webhook/);
    expect(JSON.parse(data.snapshotJson).configuration.parse.status).toBe(
      "UNPARSED",
    );
    expect(JSON.parse(data.snapshotJson).worktree).toMatchObject({
      codeStateHash: "state-before-build",
      hasStagedChanges: false,
      hasUnstagedChanges: false,
    });
  });

  test.each([
    ["LOCAL", "http://127.0.0.1:3000"],
    ["REMOTE", "https://builds.example.com"],
    ["PROXY", "https://aide.example.ts.net"],
  ] as const)(
    "keeps %s build jobs compatible with agents requiring telemetry URLs",
    async (serverUrlKind, selectedBaseUrl) => {
      const buildCreate = vi.fn().mockResolvedValue({ id: "build-1" });
      const createJob = vi.fn().mockResolvedValue({ id: "build-job" });
      const telemetrySettings = {
        consoleCollectionEnabled: true,
        analyticsCollectionEnabled: false,
      };
      const telemetry = {
        buildSettings: vi.fn().mockResolvedValue(telemetrySettings),
        notifyChange: vi.fn(),
      } as unknown as TelemetryService;
      getPrismaClient.mockResolvedValue({
        build: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: buildCreate,
          update: vi.fn().mockResolvedValue({ id: "build-1" }),
          findUniqueOrThrow: vi
            .fn()
            .mockResolvedValue({ id: "build-1", status: "QUEUED" }),
        },
        worktree: { findUnique: vi.fn().mockResolvedValue(worktree()) },
        buildConfiguration: {
          findUnique: vi.fn().mockResolvedValue(configuration()),
        },
        buildSourceObservation: {
          findUnique: vi.fn().mockResolvedValue(observation()),
        },
        codebaseRepositoryBuildScript: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        telemetryEntry: { create: vi.fn().mockResolvedValue({}) },
        $transaction: vi.fn((operations) => Promise.all(operations)),
      });

      await new BuildsService(control(createJob), telemetry).startBuild({
        worktreeId: "worktree-1",
        configurationId: "configuration-1",
        destination,
        serverUrlKind,
        action: "BUILD",
        requestId: `compatible-build-${serverUrlKind}`,
      });

      const payload = createJob.mock.calls[0]![0].payload;
      expect(payload.telemetry).toEqual({
        ...telemetrySettings,
        localBaseUrl: "http://127.0.0.1:3000",
        remoteBaseUrl: "https://builds.example.com",
        selectedBaseUrl,
        consoleLogsUrl: `${selectedBaseUrl}/api/telemetry/console-logs`,
        analyticsEventsUrl: `${selectedBaseUrl}/api/telemetry/analytics-events`,
      });
      const parsed = parseBuildJobPayload(payload);
      expect(parsed.telemetry).toEqual(telemetrySettings);
      expect(parsed.server).toEqual(payload.server);
      expect(parsed.endpointPaths).toEqual(payload.endpointPaths);
      expect(
        JSON.parse(buildCreate.mock.calls[0]![0].data.snapshotJson).telemetry,
      ).toEqual(telemetrySettings);
    },
  );

  test("reconciles hook results and code state at completion without live progress reports", async () => {
    let completeBuild:
      | ((job: {
          id: string;
          status: string;
          resultJson: string | null;
          error: string | null;
        }) => Promise<void>)
      | undefined;
    const buildUpdate = vi.fn();
    const worktreeUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const finalScriptResult = {
      phase: "PRE_BUILD",
      position: 0,
      status: "FAILED",
      exitCode: 1,
      durationMs: 125,
      causedBuildFailure: false,
      outputRelativePath: "hooks/pre/000-setup.log",
      error: "Optional hook failed",
    };
    const transaction = {
      build: { update: buildUpdate },
      worktree: { updateMany: worktreeUpdate },
      buildArtifact: { upsert: vi.fn() },
      buildScriptExecution: { updateMany: vi.fn() },
    };
    getPrismaClient.mockResolvedValue({
      build: {
        findFirst: vi.fn().mockResolvedValue({
          id: "build-1",
          status: "RUNNING",
          errorCode: null,
          error: null,
          startedAt: new Date(0),
          worktreeId: "worktree-1",
          snapshotJson: JSON.stringify({
            worktree: { id: "worktree-1", codeStateHash: "queued-state" },
          }),
        }),
      },
      $transaction: vi.fn((callback) => callback(transaction)),
    });
    new BuildsService({
      registerCompletionHandler: vi.fn((kind, handler) => {
        if (kind === IOS_BUILD_JOB_KIND) completeBuild = handler as never;
      }),
    } as unknown as AgentControlService);

    await completeBuild!({
      id: "job-1",
      status: "SUCCEEDED",
      resultJson: JSON.stringify({
        sourceStateHash: "state-before-hooks",
        finalStateHash: "state-after-post-hooks",
        codeStateObservedAt: "2026-07-18T20:00:00.000Z",
        artifacts: [],
        scriptExecutions: [finalScriptResult],
        warnings: ["Process inspection timed out; result preserved"],
      }),
      error: null,
    });

    expect(buildUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshotJson: expect.stringContaining("state-before-hooks"),
          status: "SUCCEEDED",
        }),
      }),
    );
    expect(
      JSON.parse(buildUpdate.mock.calls[0][0].data.snapshotJson),
    ).toMatchObject({
      warnings: ["Process inspection timed out; result preserved"],
      worktree: { codeStateHash: "state-before-hooks" },
    });
    expect(transaction.buildScriptExecution.updateMany).toHaveBeenCalledWith({
      where: { buildId: "build-1", phase: "PRE_BUILD", position: 0 },
      data: {
        status: "FAILED",
        exitCode: 1,
        durationMs: 125,
        causedBuildFailure: false,
        outputRelativePath: "hooks/pre/000-setup.log",
        error: "Optional hook failed",
      },
    });
    expect(worktreeUpdate).toHaveBeenCalledWith({
      where: {
        id: "worktree-1",
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lt: new Date("2026-07-18T20:00:00.000Z") } },
        ],
      },
      data: {
        codeStateHash: "state-after-post-hooks",
        lastCheckedAt: new Date("2026-07-18T20:00:00.000Z"),
      },
    });
  });

  test.each([
    ["SUCCEEDED", "IOS_BUILD_SUCCEEDED", "iOS build succeeded"],
    ["FAILED", "IOS_BUILD_FAILED", "iOS build failed"],
  ])(
    "records and publishes a %s iOS build notification",
    async (jobStatus, typeKey, title) => {
      let completeBuild:
        | Parameters<AgentControlService["registerCompletionHandler"]>[1]
        | undefined;
      const notification = {
        id: "notification-1",
        typeKey,
        title,
      };
      const recordInTransaction = vi.fn().mockResolvedValue(notification);
      const created = vi.fn();
      const transaction = {
        build: { update: vi.fn() },
        worktree: { updateMany: vi.fn() },
        buildArtifact: { upsert: vi.fn() },
        buildScriptExecution: { updateMany: vi.fn() },
      };
      getPrismaClient.mockResolvedValue({
        build: {
          findFirst: vi.fn().mockResolvedValue({
            id: "build-1",
            status: "RUNNING",
            errorCode: null,
            error: null,
            startedAt: new Date(0),
            worktreeId: "worktree-1",
            worktree: { highlightColor: "blue" },
            snapshotJson: JSON.stringify({
              repository: { name: "Example" },
              configuration: { name: "Debug" },
              worktree: { id: "worktree-1", branch: "main" },
            }),
          }),
        },
        $transaction: vi.fn((callback) => callback(transaction)),
      });
      new BuildsService(
        {
          registerCompletionHandler: vi.fn((kind, handler) => {
            if (kind === IOS_BUILD_JOB_KIND) completeBuild = handler;
          }),
        } as unknown as AgentControlService,
        undefined,
        { recordInTransaction, created } as never,
      );

      await completeBuild!({
        id: "job-1",
        status: jobStatus,
        resultJson: JSON.stringify({ artifacts: [], scriptExecutions: [] }),
        error: jobStatus === "FAILED" ? "Build failed" : null,
      } as never);

      expect(recordInTransaction).toHaveBeenCalledWith(
        transaction,
        expect.objectContaining({
          dedupeKey: `ios-build:build-1:${jobStatus}`,
          typeKey,
          title,
          body: "Example · Debug · main",
          href: "/dashboard/builds/build-1",
          highlightColor: "blue",
        }),
      );
      expect(created).toHaveBeenCalledWith(notification);
    },
  );

  test("does not record a notification for a cancelled iOS build", async () => {
    let completeBuild:
      | Parameters<AgentControlService["registerCompletionHandler"]>[1]
      | undefined;
    const recordInTransaction = vi.fn();
    const transaction = {
      build: { update: vi.fn() },
      worktree: { updateMany: vi.fn() },
      buildArtifact: { upsert: vi.fn() },
      buildScriptExecution: { updateMany: vi.fn() },
    };
    getPrismaClient.mockResolvedValue({
      build: {
        findFirst: vi.fn().mockResolvedValue({
          id: "build-1",
          status: "RUNNING",
          errorCode: null,
          error: null,
          startedAt: new Date(0),
          worktreeId: "worktree-1",
          worktree: { highlightColor: null },
          snapshotJson: JSON.stringify({ worktree: { id: "worktree-1" } }),
        }),
      },
      $transaction: vi.fn((callback) => callback(transaction)),
    });
    new BuildsService(
      {
        registerCompletionHandler: vi.fn((kind, handler) => {
          if (kind === IOS_BUILD_JOB_KIND) completeBuild = handler;
        }),
      } as unknown as AgentControlService,
      undefined,
      { recordInTransaction, created: vi.fn() } as never,
    );

    await completeBuild!({
      id: "job-1",
      status: "CANCELLED",
      resultJson: JSON.stringify({ artifacts: [], scriptExecutions: [] }),
      error: null,
    } as never);

    expect(recordInTransaction).not.toHaveBeenCalled();
  });

  test("projects a completion that arrives before the build job is attached", async () => {
    let completeBuild:
      | Parameters<AgentControlService["registerCompletionHandler"]>[1]
      | undefined;
    const payloadJson = JSON.stringify({ buildId: "pending-build" });
    const findFirst = vi.fn().mockResolvedValue({
      id: "pending-build",
      jobId: null,
      queuePayloadJson: payloadJson,
      status: "QUEUED",
      snapshotJson: "{}",
    });
    const update = vi.fn();
    getPrismaClient.mockResolvedValue({
      build: { findFirst },
      $transaction: vi.fn((callback) => callback({ build: { update } })),
    });
    new BuildsService({
      registerCompletionHandler: vi.fn((kind, handler) => {
        if (kind === IOS_BUILD_JOB_KIND) completeBuild = handler;
      }),
    } as unknown as AgentControlService);

    await completeBuild!({
      id: "finished-job",
      agentId: "agent-1",
      payloadJson,
      status: "SUCCEEDED",
      resultJson: "{}",
      error: null,
    } as never);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { jobId: "finished-job" },
            {
              id: "pending-build",
              agentId: "agent-1",
              jobId: null,
              queuePayloadJson: payloadJson,
            },
          ],
        },
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobId: "finished-job",
          queuePayloadJson: null,
          status: "SUCCEEDED",
        }),
      }),
    );
  });

  test("inherits shared export settings for saved and Custom platform overrides", async () => {
    const customConfiguration = {
      sourceKind: "WORKSPACE" as const,
      sourcePath: "App.xcworkspace",
      scheme: "App",
      buildConfiguration: "Debug",
    };
    const exportSettings = {
      method: "DEBUGGING",
      signingStyle: "AUTOMATIC",
      teamId: "SHAREDTEAM",
      uploadSymbols: true,
      manageAppVersionAndBuildNumber: true,
      testFlightInternalTestingOnly: false,
    };
    const platformConfigurations = [
      { platform: "TVOS" as const, exportSettings: { teamId: "TVTEAM1234" } },
    ];
    const buildWorktree = worktree();
    buildWorktree.codebase.agent.capabilitiesJson = JSON.stringify([
      IOS_BUILD_JOB_KIND,
      XCODE_MULTIPLATFORM_BUILD_CAPABILITY,
    ]);
    const project = { id: "project-1", repositoryId: "repository-1" };
    const save = vi.fn(({ create }) => ({ ...configuration(), ...create }));
    const findConfiguration = vi.fn();
    const create = vi.fn();
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
        update: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "archive-build" }),
      },
      codebase: { findUnique: vi.fn().mockResolvedValue(project) },
      codebaseProject: {
        findUnique: vi.fn().mockResolvedValue(project),
        upsert: vi.fn().mockResolvedValue(project),
      },
      buildConfiguration: { findUnique: findConfiguration, upsert: save },
      buildSource: {
        upsert: vi.fn().mockResolvedValue(configuration().source),
      },
      buildSourceObservation: { findUnique: vi.fn().mockResolvedValue(null) },
      worktree: { findUnique: vi.fn().mockResolvedValue(buildWorktree) },
      codebaseRepositoryBuildScript: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = new BuildsService(control());
    const saved = await service.saveConfiguration({
      ...customConfiguration,
      codebaseId: "codebase-1",
      name: "Archive",
      defaultAction: "ARCHIVE",
      autoExport: true,
      exportSettings,
      platformConfigurations,
    });
    expect(JSON.parse(saved.platformConfigurationsJson)).toEqual(
      platformConfigurations,
    );
    findConfiguration.mockResolvedValue(saved);
    const archive = {
      worktreeId: "worktree-1",
      destination: {
        type: "PHYSICAL_DEVICE",
        id: "generic-tvos",
        name: "Any Physical tvOS Device",
        platform: "tvOS",
        osVersion: null,
        state: null,
        generic: true,
      },
      action: "ARCHIVE" as const,
    };
    await service.startBuild({
      ...archive,
      configurationId: saved.id,
      requestId: "saved-archive",
    });
    await service.startBuild({
      ...archive,
      customConfiguration: {
        ...customConfiguration,
        exportSettings,
        platformConfigurations,
      },
      exportWhenComplete: true,
      requestId: "custom-archive",
    });
    expect(create).toHaveBeenCalledTimes(2);
    for (const [{ data }] of create.mock.calls) {
      expect(JSON.parse(data.snapshotJson).configuration).toMatchObject({
        autoExport: true,
        exportSettings: { ...exportSettings, teamId: "TVTEAM1234" },
      });
    }
  });

  test("queues one automatic export from the immutable build snapshot", async () => {
    let completeBuild:
      | Parameters<AgentControlService["registerCompletionHandler"]>[1]
      | undefined;
    const transaction = {
      build: { update: vi.fn() },
      worktree: { updateMany: vi.fn() },
      buildArtifact: { upsert: vi.fn() },
      buildScriptExecution: { updateMany: vi.fn() },
    };
    const exportSettings = {
      method: "DEBUGGING",
      signingStyle: "AUTOMATIC",
      teamId: "ABCDE12345",
      signingCertificate: null,
      provisioningProfiles: {},
      uploadSymbols: true,
      manageAppVersionAndBuildNumber: true,
      testFlightInternalTestingOnly: false,
      stripSwiftSymbols: true,
      thinning: null,
      iCloudContainerEnvironment: null,
      distributionBundleIdentifier: null,
    };
    getPrismaClient.mockResolvedValue({
      build: {
        findFirst: vi.fn().mockResolvedValue({
          id: "archive-build",
          status: "RUNNING",
          errorCode: null,
          error: null,
          startedAt: new Date(0),
          worktreeId: "worktree-1",
          snapshotJson: JSON.stringify({
            worktree: { id: "worktree-1" },
            configuration: {
              autoExport: true,
              exportSettings,
            },
          }),
        }),
      },
      $transaction: vi.fn((callback) => callback(transaction)),
    });
    const service = new BuildsService({
      registerCompletionHandler: vi.fn((kind, handler) => {
        if (kind === IOS_BUILD_JOB_KIND) completeBuild = handler;
      }),
    } as unknown as AgentControlService);
    const exportArchive = vi
      .spyOn(service, "exportArchive")
      .mockResolvedValue({ id: "automatic-export" } as never);

    await completeBuild!({
      id: "job-1",
      status: "SUCCEEDED",
      resultJson: JSON.stringify({
        artifacts: [
          {
            kind: "ARCHIVE",
            relativePath: "App.xcarchive",
            metadata: {},
          },
        ],
        scriptExecutions: [],
      }),
      error: null,
    } as never);

    expect(exportArchive).toHaveBeenCalledOnce();
    expect(exportArchive).toHaveBeenCalledWith({
      buildId: "archive-build",
      requestId: "automatic",
      settings: exportSettings,
    });
  });

  test("resolves Xcode 26 test products from a compatible prior build", async () => {
    const persistedWorktree = worktree();
    const persistedConfiguration = configuration();
    const priorBuild = {
      id: "prior-build",
      status: "SUCCEEDED",
      action: "BUILD_FOR_TESTING",
      agentId: "agent-1",
      worktreeId: "worktree-1",
      configurationId: "configuration-1",
      destinationType: "SIMULATOR",
      artifactDirectory: "/agent/builds/prior-build",
      snapshotJson: JSON.stringify({
        configuration: {
          advancedSettings: { testPlan: "TestPlan" },
        },
      }),
      artifacts: [],
    };
    const buildCreate = vi.fn().mockResolvedValue({ id: "new-build" });
    const buildUpdate = vi.fn().mockResolvedValue({ id: "new-build" });
    const createdBuild = { id: "new-build", status: "QUEUED" };
    const prisma = {
      build: {
        findUnique: vi.fn(({ where }) =>
          Promise.resolve(where.id === "prior-build" ? priorBuild : null),
        ),
        create: buildCreate,
        update: buildUpdate,
        findUniqueOrThrow: vi.fn().mockResolvedValue(createdBuild),
      },
      worktree: { findUnique: vi.fn().mockResolvedValue(persistedWorktree) },
      buildConfiguration: {
        findUnique: vi.fn().mockResolvedValue(persistedConfiguration),
      },
      buildSourceObservation: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      codebaseRepositoryBuildScript: {
        findMany: vi.fn().mockResolvedValue([
          {
            repositoryId: "repository-1",
            scriptId: "script-1",
            position: 0,
            script: {
              id: "script-1",
              name: "Generate",
              preBuildScript: "console.log('snapshot source')",
              postBuildScript: null,
              timeoutSeconds: 60,
              failureBehavior: "FAIL_BUILD",
              lockScope: "CODEBASE",
            },
          },
        ]),
      },
      agentJob: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const createJob = vi.fn((input) =>
      Promise.resolve({
        id:
          input.kind === IOS_DESTINATIONS_JOB_KIND
            ? "destinations-job"
            : "build-job",
      }),
    );
    const service = new BuildsService({
      registerCompletionHandler: vi.fn(),
      createJob,
      getJob: vi.fn().mockResolvedValue({
        id: "destinations-job",
        status: "SUCCEEDED",
        resultJson: JSON.stringify({ destinations: [destination] }),
        error: null,
      }),
    } as unknown as AgentControlService);

    await expect(
      service.startBuild({
        worktreeId: "worktree-1",
        configurationId: "configuration-1",
        destination,
        scriptIds: ["script-1"],
        action: "TEST_WITHOUT_BUILDING",
        advancedSettings: {
          priorBuildForTestingId: "prior-build",
          priorXctestrunPath: "/client/supplied/path.xctestrun",
        },
        requestId: "request-2",
      }),
    ).resolves.toBe(createdBuild);

    const jobInput = createJob.mock.calls.find(
      ([input]) => input.kind === IOS_BUILD_JOB_KIND,
    )![0];
    expect(
      createJob.mock.calls.some(
        ([input]) => input.kind === IOS_DESTINATIONS_JOB_KIND,
      ),
    ).toBe(false);
    expect(jobInput.payload.advancedSettings).toMatchObject({
      priorBuildForTestingId: "prior-build",
      priorTestProductsPath:
        "/agent/builds/prior-build/test-products.xctestproducts",
      priorXctestrunPath: null,
      testPlan: "TestPlan",
    });
    expect(
      jobInput.payload.advancedSettings.priorTestProductsPath,
    ).not.toContain("/client/supplied");
    const createInput = buildCreate.mock.calls[0]![0];
    expect(createInput.data.artifactDirectory).toBe(
      `/agent/repositories/Builds/${createInput.data.id}`,
    );
    expect(createInput.data.commandSummary).toContain(
      "-testProductsPath /agent/builds/prior-build/test-products.xctestproducts",
    );
    expect(createInput.data.commandSummary).not.toContain("-project");
    expect(createInput.data.commandSummary).not.toContain("-workspace");
    expect(createInput.data.commandSummary).not.toContain("-scheme");
    expect(createInput.data.commandSummary).not.toContain("-configuration");
    expect(createInput.data.commandSummary).toContain(
      "-derivedDataPath /agent/repositories/Builds/.worktree-derived-data/worktree-1",
    );
    const snapshot = JSON.parse(createInput.data.snapshotJson) as {
      configuration: {
        parse: { status: string };
        advancedSettings: {
          priorTestProductsPath: string;
          priorXctestrunPath: null;
        };
      };
      scripts: Array<{ preBuildScript: string }>;
    };
    expect(snapshot.configuration.advancedSettings.priorTestProductsPath).toBe(
      "/agent/builds/prior-build/test-products.xctestproducts",
    );
    expect(
      snapshot.configuration.advancedSettings.priorXctestrunPath,
    ).toBeNull();
    expect(snapshot.configuration.parse.status).toBe("UNPARSED");
    expect(snapshot.scripts[0]?.preBuildScript).toBe(
      "console.log('snapshot source')",
    );
    expect(snapshot.scripts[0]).toMatchObject({ lockScope: "CODEBASE" });
    expect(createInput.data.scriptExecutions.create[0]).toMatchObject({
      nameSnapshot: "Generate",
      sourceSnapshot: "console.log('snapshot source')",
    });
  });

  test("rejects an incompatible prior Build for Testing before persistence", async () => {
    const buildCreate = vi.fn();
    const prisma = {
      build: {
        findUnique: vi.fn(({ where }) =>
          Promise.resolve(
            where.id === "prior-build"
              ? {
                  id: "prior-build",
                  status: "SUCCEEDED",
                  action: "BUILD_FOR_TESTING",
                  agentId: "different-agent",
                  worktreeId: "worktree-1",
                  configurationId: "configuration-1",
                  destinationType: "SIMULATOR",
                  artifactDirectory: "/agent/builds/prior-build",
                  artifacts: [
                    {
                      kind: "XCTESTRUN",
                      relativePath: "test-products/App.xctestrun",
                    },
                  ],
                }
              : null,
          ),
        ),
        create: buildCreate,
      },
      worktree: { findUnique: vi.fn().mockResolvedValue(worktree()) },
      buildConfiguration: {
        findUnique: vi.fn().mockResolvedValue(configuration()),
      },
      buildSourceObservation: {
        findUnique: vi.fn().mockResolvedValue(observation()),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const service = new BuildsService(control());

    await expect(
      service.startBuild({
        worktreeId: "worktree-1",
        configurationId: "configuration-1",
        destination,
        action: "TEST_WITHOUT_BUILDING",
        advancedSettings: { priorBuildForTestingId: "prior-build" },
        requestId: "request-3",
      }),
    ).rejects.toThrow("not compatible");
    expect(buildCreate).not.toHaveBeenCalled();
  });

  test("refreshes run destinations from the immutable snapshot after configuration deletion", async () => {
    const prisma = {
      build: {
        findUnique: vi.fn().mockResolvedValue({
          id: "build-1",
          status: "SUCCEEDED",
          agentId: "agent-1",
          codebaseId: "codebase-1",
          worktreeId: "worktree-1",
          destinationType: "SIMULATOR",
          snapshotJson: JSON.stringify({
            configuration: {
              source: { kind: "WORKSPACE", relativePath: "App.xcworkspace" },
              scheme: "Snapshot Scheme",
              buildConfiguration: "Snapshot Debug",
            },
          }),
          artifacts: [{ kind: "RUNNABLE_APP" }],
        }),
      },
      worktree: { findUnique: vi.fn().mockResolvedValue(worktree()) },
      agentJob: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const createJob = vi.fn().mockResolvedValue({ id: "destinations-job" });
    const service = new BuildsService({
      registerCompletionHandler: vi.fn(),
      createJob,
      getJob: vi.fn().mockResolvedValue({
        id: "destinations-job",
        status: "SUCCEEDED",
        resultJson: JSON.stringify({
          destinations: [
            destination,
            { ...destination, id: "SIM-OFFLINE", available: false },
            {
              type: "PHYSICAL_DEVICE",
              id: "DEVICE-1",
              name: "Test iPhone",
              platform: "iOS",
              osVersion: "26.0",
              state: "connected",
            },
          ],
        }),
        error: null,
      }),
    } as unknown as AgentControlService);

    await expect(
      service.destinationsForBuild("build-1", "request-4"),
    ).resolves.toEqual([
      destination,
      { ...destination, id: "SIM-OFFLINE", available: false },
    ]);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: IOS_RUN_DESTINATIONS_JOB_KIND,
        idempotencyKey: "ios:build-destinations:request-4:build-1",
        payload: expect.objectContaining({
          destinationType: "SIMULATOR",
        }),
      }),
    );
  });

  test("returns generic, idle paired, and unavailable build targets from the agent preflight", async () => {
    const createJob = vi.fn().mockResolvedValue({ id: "destinations-job" });
    const genericSimulator = {
      type: "SIMULATOR",
      id: "generic-ios-simulator",
      name: "Any iOS Simulator",
      platform: "iOS Simulator",
      osVersion: null,
      state: null,
      generic: true,
    };
    const genericPhysical = {
      type: "PHYSICAL_DEVICE",
      id: "generic-ios",
      name: "Any Physical iOS Device",
      platform: "iOS",
      osVersion: null,
      state: null,
      generic: true,
    };
    const idlePhysical = {
      ...genericPhysical,
      id: "IDLE-DEVICE",
      name: "Idle iPhone",
      generic: false,
      state: "Available (paired)",
      available: true,
    };
    const offlinePhysical = {
      ...idlePhysical,
      id: "OFFLINE-DEVICE",
      state: "Unavailable",
      available: false,
    };
    const destinations = [
      genericSimulator,
      genericPhysical,
      destination,
      idlePhysical,
      offlinePhysical,
    ];
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(worktree()) },
      buildConfiguration: {
        findUnique: vi.fn().mockResolvedValue(configuration()),
      },
      agentJob: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    });
    const service = new BuildsService({
      registerCompletionHandler: vi.fn(),
      createJob,
      getJob: vi.fn().mockResolvedValue({
        id: "destinations-job",
        status: "SUCCEEDED",
        resultJson: JSON.stringify({
          destinations,
        }),
        error: null,
      }),
    } as unknown as AgentControlService);

    await expect(
      service.destinations({
        worktreeId: "worktree-1",
        configurationId: "configuration-1",
        action: "BUILD",
        requestId: "generic-destinations",
      }),
    ).resolves.toEqual(destinations);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: IOS_DESTINATIONS_JOB_KIND,
        payload: expect.objectContaining({ action: "BUILD" }),
      }),
    );
  });

  test("queues per-platform settings independently and replays accepted batch entries", async () => {
    const buildWorktree = worktree();
    const createJob = vi.fn().mockResolvedValue({ id: "job-1" });
    const rows = new Map<string, Record<string, unknown>>();
    let digest: string | undefined;
    const build = {
      findUnique: vi.fn(({ where }) => rows.get(where.requestKey) ?? null),
      findUniqueOrThrow: vi.fn(({ where }) =>
        [...rows.values()].find((row) => row.id === where.id),
      ),
      create: vi.fn(({ data }) => rows.set(data.requestKey, data)),
      update: vi.fn(({ where, data }) => {
        const row = [...rows.values()].find((entry) => entry.id === where.id);
        Object.assign(row!, data);
      }),
    };
    getPrismaClient.mockResolvedValue({
      build,
      buildBatchRequestReceipt: {
        upsert: vi.fn(({ create }) => ({
          payloadDigest: (digest ??= create.payloadDigest),
        })),
      },
      worktree: { findUnique: vi.fn().mockResolvedValue(buildWorktree) },
      buildConfiguration: {
        findUnique: vi.fn().mockResolvedValue({
          ...configuration(),
          platformConfigurationsJson: JSON.stringify([
            { platform: "IOS" },
            {
              platform: "TVOS",
              sourceKind: "PROJECT",
              sourcePath: "TV.xcodeproj",
              scheme: "TV",
              buildConfiguration: "Release",
              advancedSettings: { developmentTeam: "TELEVISION" },
            },
          ]),
        }),
      },
      buildSourceObservation: { findUnique: vi.fn().mockResolvedValue(null) },
      codebaseRepositoryBuildScript: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = new BuildsService(control(createJob));
    const input = {
      worktreeId: "worktree-1",
      configurationId: "configuration-1",
      requestId: "batch-1",
      selections: [
        { platform: "IOS", destination },
        {
          platform: "TVOS",
          destination: {
            ...destination,
            id: "TV-1",
            platform: "tvOS Simulator",
            platformId: "TVOS",
          },
        },
      ],
    } as const;
    const request = { ...input, selections: [...input.selections] };
    const first = await service.startBuilds(request);
    expect(first).toMatchObject([
      { platform: "IOS", build: { status: "QUEUED" }, error: null },
      {
        platform: "TVOS",
        build: null,
        error: expect.stringContaining("Update the build agent"),
      },
    ]);
    expect(createJob).toHaveBeenCalledTimes(1);

    buildWorktree.codebase.agent.capabilitiesJson = JSON.stringify([
      IOS_BUILD_JOB_KIND,
      XCODE_MULTIPLATFORM_BUILD_CAPABILITY,
    ]);
    build.update.mockRejectedValueOnce(new Error("Could not attach the job"));
    await expect(service.startBuilds(request)).rejects.toThrow(
      "Could not attach the job",
    );
    expect(createJob).toHaveBeenCalledTimes(2);

    const resumed = await service.startBuilds(request);
    expect(resumed[0]?.build?.id).toBe(first[0]?.build?.id);
    expect(resumed[1]?.build?.commandSummary).toContain(
      "platform=tvOS Simulator,id=TV-1",
    );
    expect(createJob).toHaveBeenCalledTimes(3);
    expect(createJob.mock.calls[2]).toEqual(createJob.mock.calls[1]);
    expect(createJob.mock.calls[1]?.[0].payload).toMatchObject({
      scheme: "TV",
      configuration: "Release",
      source: { kind: "PROJECT", relativePath: "TV.xcodeproj" },
      advancedSettings: { developmentTeam: "TELEVISION" },
    });
    await service.startBuilds(request);
    expect(createJob).toHaveBeenCalledTimes(3);
    await expect(
      service.startBuilds({ ...request, scriptIds: ["other"] }),
    ).rejects.toThrow("already used with different settings");
  });

  test("offers only artifact-compatible run platforms and keeps iOS SDK variants separate", async () => {
    const buildWorktree = worktree();
    buildWorktree.codebase.agent.capabilitiesJson = JSON.stringify([
      IOS_RUN_DESTINATIONS_JOB_KIND,
      XCODE_MULTIPLATFORM_BUILD_CAPABILITY,
    ]);
    const vision = {
      ...destination,
      id: "VISION-1",
      platform: "visionOS Simulator",
      platformId: "VISIONOS_DESIGNED_FOR_IPAD",
      osVersion: "2.0",
    };
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn().mockResolvedValue({
          id: "build-1",
          status: "SUCCEEDED",
          agentId: "agent-1",
          codebaseId: "codebase-1",
          worktreeId: "worktree-1",
          destinationType: "SIMULATOR",
          destinationJson: JSON.stringify(destination),
          artifacts: [
            {
              kind: "RUNNABLE_APP",
              metadataJson: JSON.stringify({
                minimumOSVersion: "26.0",
                compatiblePlatforms: ["IOS", "VISIONOS_DESIGNED_FOR_IPAD"],
              }),
            },
          ],
        }),
      },
      worktree: { findUnique: vi.fn().mockResolvedValue(buildWorktree) },
      agentJob: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    });
    const createJob = vi.fn().mockResolvedValue({ id: "destinations-job" });
    const service = new BuildsService({
      registerCompletionHandler: vi.fn(),
      createJob,
      getJob: vi.fn().mockResolvedValue({
        id: "destinations-job",
        status: "SUCCEEDED",
        error: null,
        resultJson: JSON.stringify({
          destinations: [
            destination,
            vision,
            { ...vision, platformId: "VISIONOS" },
            { ...destination, platform: "tvOS Simulator", platformId: "TVOS" },
          ],
        }),
      }),
    } as unknown as AgentControlService);
    await expect(
      service.destinationsForBuild("build-1", "request-vision"),
    ).resolves.toEqual([destination, vision]);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          platforms: ["IOS", "VISIONOS_DESIGNED_FOR_IPAD"],
        }),
      }),
    );
  });

  test("orders and paginates build-wide logs by timestamp and sequence", async () => {
    const createdAt = new Date("2026-07-18T12:00:00Z");
    const findMany = vi.fn().mockResolvedValue([]);
    getPrismaClient.mockResolvedValue({
      buildLogChunk: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "log-4", createdAt, sequence: 4 }),
        findMany,
      },
    });

    await new BuildsService(control()).logChunks("build-1", "log-4", 25);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        buildId: "build-1",
        OR: [
          { createdAt: { gt: createdAt } },
          { createdAt, sequence: { gt: 4 } },
          { createdAt, sequence: 4, id: { gt: "log-4" } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { sequence: "asc" }, { id: "asc" }],
      take: 25,
    });
  });

  test.each([
    {
      name: "simulator",
      selectedDestination: { ...destination, state: "Shutdown" },
      refreshedDestination: { ...destination, state: "Booted" },
    },
    {
      name: "idle paired physical device",
      selectedDestination: {
        ...destination,
        type: "PHYSICAL_DEVICE" as const,
        id: "DEVICE-1",
        platform: "iOS",
        state: "Connected",
        available: true,
      },
      refreshedDestination: {
        ...destination,
        type: "PHYSICAL_DEVICE" as const,
        id: "DEVICE-1",
        platform: "iOS",
        state: "Available (paired)",
        available: true,
      },
    },
  ])(
    "reuses a $name deployment retry after refreshing status",
    async ({ selectedDestination, refreshedDestination }) => {
      const buildWorktree = worktree();
      buildWorktree.codebase.agent.capabilitiesJson = JSON.stringify([
        IOS_DEPLOY_JOB_KIND,
      ]);
      const deployment = {
        id: "deployment-1",
        buildId: "build-1",
        requestId: "run-1",
        destinationJson: JSON.stringify(selectedDestination),
        destinationKey: `${selectedDestination.type}:${selectedDestination.id}`,
        status: "RUNNING",
      };
      const findDeployment = vi.fn().mockResolvedValue(deployment);
      const createDeployment = vi.fn();
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      getPrismaClient.mockResolvedValue({
        build: {
          findUnique: vi.fn().mockResolvedValue({
            id: "build-1",
            status: "SUCCEEDED",
            destinationType: selectedDestination.type,
            artifactDirectory: "/agent/builds/build-1",
            artifacts: [
              {
                id: "artifact-1",
                kind: "RUNNABLE_APP",
                relativePath: "products/App.app",
                metadataJson: JSON.stringify({
                  bundleIdentifier: "com.example.app",
                }),
              },
            ],
            worktree: buildWorktree,
          }),
        },
        worktree: { findUnique: vi.fn().mockResolvedValue(buildWorktree) },
        buildDeployment: {
          findUnique: findDeployment,
          create: createDeployment,
          updateMany,
          findMany: vi.fn().mockResolvedValue([deployment]),
        },
      });
      const createJob = vi.fn().mockResolvedValue({ id: "deployment-job" });
      const service = new BuildsService(control(createJob));
      const refreshDestinations = vi
        .spyOn(service, "destinationsForBuild")
        .mockResolvedValue([refreshedDestination]);

      await expect(
        service.runBuild({
          buildId: "build-1",
          destinations: [selectedDestination],
          requestId: "run-1",
        }),
      ).resolves.toEqual([deployment]);

      expect(findDeployment).toHaveBeenCalledWith({
        where: {
          buildId_requestId_targetAgentId_destinationKey: {
            buildId: "build-1",
            requestId: "run-1",
            targetAgentId: "agent-1",
            destinationKey: `${selectedDestination.type}:${selectedDestination.id}`,
          },
        },
      });
      expect(createDeployment).not.toHaveBeenCalled();
      expect(createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            deployments: [
              { id: "deployment-1", destination: refreshedDestination },
            ],
          }),
        }),
      );
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["deployment-1"] } },
        data: { jobId: "deployment-job" },
      });

      refreshDestinations.mockResolvedValueOnce([
        { ...refreshedDestination, available: false },
      ]);
      await expect(
        service.runBuild({
          buildId: "build-1",
          destinations: [selectedDestination],
          requestId: "run-offline",
        }),
      ).rejects.toThrow("no longer available");
    },
  );

  test("rejects an explicitly unavailable build destination before queuing work", async () => {
    const createJob = vi.fn();
    getPrismaClient.mockResolvedValue({
      build: { findUnique: vi.fn().mockResolvedValue(null) },
      worktree: { findUnique: vi.fn().mockResolvedValue(worktree()) },
      buildConfiguration: {
        findUnique: vi.fn().mockResolvedValue(configuration()),
      },
      buildSourceObservation: {
        findUnique: vi.fn().mockResolvedValue(observation()),
      },
    });
    await expect(
      new BuildsService(control(createJob)).startBuild({
        worktreeId: "worktree-1",
        configurationId: "configuration-1",
        destination: { ...destination, available: false },
        requestId: "unavailable-build",
      }),
    ).rejects.toThrow("The selected build destination is unavailable");
    expect(createJob).not.toHaveBeenCalled();
  });

  test("fails cross-agent deployments when job queuing stops midway", async () => {
    const deployment = {
      id: "deployment-1",
      buildId: "build-1",
      requestId: "run-cross-agent",
      destinationJson: JSON.stringify(destination),
      destinationKey: "SIMULATOR:SIM-1",
      targetAgentId: "target-agent",
      transferId: null,
      status: "TRANSFERRING",
    };
    const transferUpdate = vi.fn().mockResolvedValue({});
    const deploymentUpdate = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn().mockResolvedValue({
          id: "build-1",
          status: "SUCCEEDED",
          agentId: "source-agent",
          destinationType: "SIMULATOR",
          artifactDirectory: "/agent/builds/build-1",
          artifacts: [
            {
              id: "artifact-1",
              kind: "RUNNABLE_APP",
              relativePath: "products/Acme.app",
              metadataJson: JSON.stringify({
                bundleIdentifier: "com.example.acme",
              }),
            },
          ],
          worktree: null,
        }),
      },
      buildDeployment: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(deployment),
        updateMany: deploymentUpdate,
      },
      buildArtifactTransfer: {
        create: vi.fn().mockResolvedValue({}),
        update: transferUpdate,
      },
      $transaction: vi.fn(async (operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    });
    const createJob = vi
      .fn()
      .mockResolvedValueOnce({ id: "source-job" })
      .mockRejectedValueOnce(new Error("Target agent queue is unavailable"));
    const service = new BuildsService(control(createJob));
    vi.spyOn(service, "runAgentsForBuild").mockResolvedValue([
      {
        agent: { id: "target-agent" },
        isBuildAgent: false,
        available: true,
        unavailableReason: null,
      },
    ] as never);
    vi.spyOn(service, "destinationsForBuild").mockResolvedValue([destination]);

    await expect(
      service.runBuild({
        buildId: "build-1",
        targetAgentId: "target-agent",
        destinations: [destination],
        requestId: "run-cross-agent",
      }),
    ).rejects.toThrow("Target agent queue is unavailable");

    expect(transferUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          error: "Target agent queue is unavailable",
        }),
      }),
    );
    expect(deploymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          error: "Target agent queue is unavailable",
        }),
      }),
    );
  });

  test("redacts common credentials again before central log persistence", async () => {
    const upsert = vi.fn(async ({ create }) => create);
    const publish = vi.spyOn(agentEventBus, "publish");
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn().mockResolvedValue({
          id: "build-1",
          agentId: "agent-1",
        }),
      },
      buildLogChunk: { upsert },
    });
    const service = new BuildsService(control());

    const raw = Buffer.from(
      "Bearer abc.def API_TOKEN=secret https://user:password@example.com",
    );
    await service.appendLogChunks("agent-1", "build-1", [
      {
        scope: "BUILD",
        scopeId: "build-1",
        sequence: 0,
        phase: "XCODEBUILD",
        stream: "STDOUT",
        dataBase64: raw.toString("base64"),
        byteLength: raw.byteLength,
        createdAt: new Date().toISOString(),
      },
    ]);

    const persisted = Buffer.from(
      upsert.mock.calls[0]![0].create.dataBase64 as string,
      "base64",
    ).toString("utf8");
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toMatch(/abc\.def|API_TOKEN=secret|user:password/);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          scope_scopeId_sequence: {
            scope: "BUILD",
            scopeId: "build-1",
            sequence: 0,
          },
        },
        update: {},
      }),
    );
    expect(publish).toHaveBeenCalledWith(buildLogChunkTopic("build-1"), {
      buildLogChunkAdded: expect.objectContaining({ sequence: 0 }),
    });
  });

  test("validates build log chunk batches and encoded byte lengths", async () => {
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn().mockResolvedValue({
          id: "build-1",
          agentId: "agent-1",
        }),
      },
      buildLogChunk: { upsert: vi.fn() },
    });
    const service = new BuildsService(control());
    await expect(
      service.appendLogChunks("agent-1", "build-1", []),
    ).rejects.toThrow("1 to 200 chunks");
    await expect(
      service.appendLogChunks("agent-1", "build-1", [
        {
          scope: "BUILD",
          scopeId: "build-1",
          sequence: 0,
          phase: "RUNNING",
          stream: "STDOUT",
          dataBase64: Buffer.from("output").toString("base64"),
          byteLength: 999,
          createdAt: new Date().toISOString(),
        },
      ]),
    ).rejects.toThrow("Log byte length is invalid");
  });
  test("imports a coverage report as its own host build and job", async () => {
    const worktreeRecord = {
      ...worktree(),
      baseBranchOverride: null,
      codebase: {
        ...worktree().codebase,
        defaultBranch: "main",
        agent: {
          ...worktree().codebase.agent,
          capabilitiesJson: JSON.stringify([COVERAGE_IMPORT_JOB_KIND]),
        },
      },
    };
    const create = vi
      .fn()
      .mockImplementation(({ data }) => Promise.resolve(data));
    const reportCreate = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    const createJob = vi.fn().mockResolvedValue({ id: "coverage-job" });
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(worktreeRecord) },
      build: { findUnique: vi.fn().mockResolvedValue(null), create, update },
      buildReport: { create: reportCreate },
    });

    const build = await new BuildsService(
      control(createJob),
    ).importCoverageReport({
      worktreeId: "worktree-1",
      buildName: "Test with coverage",
      reportPath: "coverage/lcov.info",
      format: "auto",
      requestId: "request-1",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestKey: "coverage:worktree-1:request-1",
          action: "TEST",
          destinationType: "HOST",
          status: "RUNNING",
          commandSummary: "Import coverage from coverage/lcov.info",
          destinationJson: expect.any(String),
        }),
      }),
    );
    expect(JSON.parse(create.mock.calls[0]![0].data.destinationJson)).toEqual({
      type: "HOST",
      id: "agent-1",
      name: "Builder",
      platform: worktreeRecord.codebase.agent.architecture,
      osVersion: worktreeRecord.codebase.agent.osVersion,
      state: "Connected",
    });
    expect(
      JSON.parse(create.mock.calls[0]![0].data.snapshotJson),
    ).toMatchObject({
      worktree: { headSha: "abc123" },
      configuration: { name: "Test with coverage" },
      coverageImport: {
        reportPath: "coverage/lcov.info",
        format: "AUTO",
        baseBranch: "main",
      },
    });
    expect(reportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "CODE_COVERAGE",
        source: "WORKTREE",
        status: "PENDING",
      }),
    });
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: COVERAGE_IMPORT_JOB_KIND,
        payload: expect.objectContaining({
          folder: "/agent/repository",
          reportPath: "coverage/lcov.info",
          format: "AUTO",
          baseBranch: "main",
        }),
        visibility: "SYSTEM",
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: build.id },
      data: { jobId: "coverage-job" },
    });
    expect(build.jobId).toBe("coverage-job");
  });

  test("fails the coverage build and report when the job cannot be queued", async () => {
    const worktreeRecord = {
      ...worktree(),
      baseBranchOverride: null,
      codebase: {
        ...worktree().codebase,
        defaultBranch: "main",
        agent: {
          ...worktree().codebase.agent,
          capabilitiesJson: JSON.stringify([COVERAGE_IMPORT_JOB_KIND]),
        },
      },
    };
    const create = vi
      .fn()
      .mockImplementation(({ data }) => Promise.resolve(data));
    const reportUpsert = vi.fn().mockResolvedValue({});
    const buildUpdate = vi.fn().mockResolvedValue({});
    const transaction = {
      buildReport: { upsert: reportUpsert },
      build: { update: buildUpdate },
    };
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(worktreeRecord) },
      build: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
      buildReport: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn((callback) => callback(transaction)),
    });
    const service = new BuildsService(
      control(vi.fn().mockRejectedValue(new Error("Agent queue unavailable"))),
    );

    await expect(
      service.importCoverageReport({
        worktreeId: "worktree-1",
        reportPath: "coverage/lcov.info",
        format: "LCOV",
        requestId: "request-1",
      }),
    ).rejects.toThrow("Agent queue unavailable");

    const buildId = create.mock.calls[0]![0].data.id;
    expect(reportUpsert).toHaveBeenCalledWith({
      where: { buildId_kind: { buildId, kind: "CODE_COVERAGE" } },
      create: expect.objectContaining({
        buildId,
        kind: "CODE_COVERAGE",
        source: "WORKTREE",
        status: "FAILED",
        error: "Agent queue unavailable",
        finishedAt: expect.any(Date),
      }),
      update: {
        status: "FAILED",
        error: "Agent queue unavailable",
        finishedAt: expect.any(Date),
      },
    });
    expect(buildUpdate).toHaveBeenCalledWith({
      where: { id: buildId },
      data: {
        status: "FAILED",
        errorCode: "QUEUE_FAILED",
        error: "Agent queue unavailable",
        finishedAt: expect.any(Date),
      },
    });
  });

  test("cancels a coverage job that cannot be attached to its build", async () => {
    const worktreeRecord = {
      ...worktree(),
      baseBranchOverride: null,
      codebase: {
        ...worktree().codebase,
        defaultBranch: "main",
        agent: {
          ...worktree().codebase.agent,
          capabilitiesJson: JSON.stringify([COVERAGE_IMPORT_JOB_KIND]),
        },
      },
    };
    const create = vi
      .fn()
      .mockImplementation(({ data }) => Promise.resolve(data));
    const reportUpsert = vi.fn().mockResolvedValue({});
    const transactionBuildUpdate = vi.fn().mockResolvedValue({});
    const cancelJob = vi.fn().mockResolvedValue({});
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(worktreeRecord) },
      build: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
        update: vi.fn().mockRejectedValue(new Error("Build attachment failed")),
      },
      buildReport: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn((callback) =>
        callback({
          buildReport: { upsert: reportUpsert },
          build: { update: transactionBuildUpdate },
        }),
      ),
    });
    const service = new BuildsService(
      control(vi.fn().mockResolvedValue({ id: "coverage-job" }), cancelJob),
    );

    await expect(
      service.importCoverageReport({
        worktreeId: "worktree-1",
        reportPath: "coverage/lcov.info",
        format: "LCOV",
        requestId: "request-1",
      }),
    ).rejects.toThrow("Build attachment failed");

    expect(cancelJob).toHaveBeenCalledWith("coverage-job");
    expect(reportUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "FAILED",
          error: "Build attachment failed",
        }),
      }),
    );
    expect(transactionBuildUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorCode: "QUEUE_FAILED",
          error: "Build attachment failed",
        }),
      }),
    );
  });

  test("rejects an unknown coverage format and an agent without the job", async () => {
    const outdated = {
      ...worktree(),
      baseBranchOverride: null,
      codebase: {
        ...worktree().codebase,
        defaultBranch: "main",
        agent: {
          ...worktree().codebase.agent,
          capabilitiesJson: JSON.stringify([IOS_BUILD_JOB_KIND]),
        },
      },
    };
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(outdated) },
    });
    const service = new BuildsService(control());

    await expect(
      service.importCoverageReport({
        worktreeId: "worktree-1",
        reportPath: "coverage/lcov.info",
        format: "COBERTURA",
        requestId: "request-1",
      }),
    ).rejects.toThrow("Agent must be updated to import coverage reports");

    getPrismaClient.mockResolvedValue({
      worktree: {
        findUnique: vi.fn().mockResolvedValue({
          ...outdated,
          codebase: {
            ...outdated.codebase,
            agent: {
              ...outdated.codebase.agent,
              capabilitiesJson: JSON.stringify([COVERAGE_IMPORT_JOB_KIND]),
            },
          },
        }),
      },
    });
    await expect(
      service.importCoverageReport({
        worktreeId: "worktree-1",
        reportPath: "coverage/lcov.info",
        format: "COBERTURA",
        requestId: "request-1",
      }),
    ).rejects.toThrow("AUTO, LCOV, or ISTANBUL");
  });
});

describe("build workflow persistence", () => {
  const customConfiguration = {
    sourceKind: "WORKSPACE" as const,
    sourcePath: "App.xcworkspace",
    scheme: "App",
    buildConfiguration: "Debug",
  };

  test("requires exactly one configuration and creates a Custom snapshot without a saved configuration", async () => {
    const create = vi.fn().mockResolvedValue({ id: "custom-build" });
    const saved = { findUnique: vi.fn(), create: vi.fn() };
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
        update: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "custom-build" }),
      },
      worktree: { findUnique: vi.fn().mockResolvedValue(worktree()) },
      codebaseProject: {
        findUnique: vi.fn().mockResolvedValue({ id: "project-1" }),
      },
      buildConfiguration: saved,
      codebaseRepositoryBuildScript: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = new BuildsService(control());
    const base = {
      worktreeId: "worktree-1",
      destination,
      requestId: "custom-request",
    };
    await expect(service.startBuild(base)).rejects.toThrow("exactly one");
    await expect(
      service.startBuild({
        ...base,
        configurationId: "configuration-1",
        customConfiguration,
      }),
    ).rejects.toThrow("exactly one");
    await expect(
      service.startBuild({
        ...base,
        customConfiguration: {
          ...customConfiguration,
          sourcePath: "../App.xcworkspace",
        },
      }),
    ).rejects.toThrow();
    await service.startBuild({ ...base, customConfiguration });
    const data = create.mock.calls[0][0].data;
    expect(data.configurationId).toBeNull();
    expect(JSON.parse(data.snapshotJson).configuration).toMatchObject({
      kind: "CUSTOM",
      name: "Custom",
      scheme: "App",
      source: { relativePath: "App.xcworkspace" },
    });
    expect(saved.create).not.toHaveBeenCalled();
    expect(saved.findUnique).not.toHaveBeenCalled();
  });

  test.each([
    ["matching", {}, true],
    ["missing Custom marker", { kind: undefined }, false],
    [
      "different source kind",
      { source: { kind: "PROJECT", relativePath: "App.xcworkspace" } },
      false,
    ],
    [
      "different source path",
      { source: { kind: "WORKSPACE", relativePath: "Other.xcworkspace" } },
      false,
    ],
    ["different scheme", { scheme: "Other" }, false],
    ["different Xcode configuration", { buildConfiguration: "Release" }, false],
  ])(
    "compares Custom test-product snapshots: %s",
    async (_name, overrides, compatible) => {
      const create = vi.fn().mockResolvedValue({ id: "new-custom" });
      const prior = {
        id: "prior-custom",
        status: "SUCCEEDED",
        action: "BUILD_FOR_TESTING",
        agentId: "agent-1",
        worktreeId: "worktree-1",
        configurationId: null,
        destinationType: "SIMULATOR",
        artifactDirectory: "/agent/builds/prior-custom",
        artifacts: [],
        snapshotJson: JSON.stringify({
          configuration: {
            kind: "CUSTOM",
            source: { kind: "WORKSPACE", relativePath: "App.xcworkspace" },
            scheme: "App",
            buildConfiguration: "Debug",
            ...overrides,
          },
        }),
      };
      getPrismaClient.mockResolvedValue({
        build: {
          findUnique: vi.fn(({ where }) =>
            Promise.resolve(where.id === "prior-custom" ? prior : null),
          ),
          create,
          update: vi.fn(),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "new-custom" }),
        },
        worktree: { findUnique: vi.fn().mockResolvedValue(worktree()) },
        codebaseProject: {
          findUnique: vi.fn().mockResolvedValue({ id: "project-1" }),
        },
        codebaseRepositoryBuildScript: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      });
      const result = new BuildsService(control()).startBuild({
        worktreeId: "worktree-1",
        customConfiguration,
        destination,
        action: "TEST_WITHOUT_BUILDING",
        advancedSettings: { priorBuildForTestingId: "prior-custom" },
        requestId: "custom-test",
      });
      if (compatible) {
        await expect(result).resolves.toEqual({ id: "new-custom" });
        expect(create.mock.calls[0][0].data.commandSummary).toContain(
          "/agent/builds/prior-custom/test-products.xctestproducts",
        );
      } else {
        await expect(result).rejects.toThrow(
          "different custom source settings",
        );
        expect(create).not.toHaveBeenCalled();
      }
    },
  );

  test("paginates configuration history and finds the latest repository build without worktree or agent filters", async () => {
    const rows = [{ id: "latest-failed", status: "FAILED" }, { id: "older" }];
    const findMany = vi.fn().mockResolvedValue(rows);
    getPrismaClient.mockResolvedValue({ build: { findMany } });
    const service = new BuildsService(control());
    const result = await service.builds({
      configurationId: "configuration-1",
      first: 1,
      after: "cursor",
    });
    expect(result).toEqual({ items: [rows[0]], nextCursor: "latest-failed" });
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { configurationId: "configuration-1" },
      cursor: { id: "cursor" },
      skip: 1,
      take: 2,
    });
    await service.builds({ repositoryId: "repository-1", first: 1 });
    expect(findMany.mock.calls[1][0].where).toEqual({
      repositoryId: "repository-1",
    });
    expect(findMany.mock.calls[1][0].orderBy).toEqual([
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });

  test("rebuilds Custom from its source snapshot but does not treat a deleted saved configuration as Custom", async () => {
    const lookup = vi.fn().mockResolvedValue({
      worktreeId: "worktree-1",
      configurationId: null,
      action: "BUILD",
      destinationJson: JSON.stringify(destination),
      snapshotJson: JSON.stringify({
        configuration: {
          kind: "CUSTOM",
          name: "Custom",
          source: { kind: "WORKSPACE", relativePath: "App.xcworkspace" },
          scheme: "App",
          buildConfiguration: "Debug",
        },
      }),
    });
    getPrismaClient.mockResolvedValue({ build: { findUnique: lookup } });
    const service = new BuildsService(control());
    const start = vi
      .spyOn(service, "startBuild")
      .mockResolvedValue({ id: "rebuilt" } as never);
    await service.rebuildBuild("build-1", "request");
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        customConfiguration,
        worktreeId: "worktree-1",
      }),
    );
    expect(start.mock.calls[0][0]).not.toHaveProperty("configurationId");
    lookup.mockResolvedValue({
      worktreeId: "worktree-1",
      configurationId: null,
      action: "BUILD",
      destinationJson: "{}",
      snapshotJson: JSON.stringify({
        configuration: { name: "Deleted Release" },
      }),
    });
    await expect(
      service.rebuildBuild("deleted-build", "retry"),
    ).rejects.toThrow("original build settings");
  });

  test("project deletion blocks active Custom builds and keeps history and script assignments", async () => {
    const active = vi
      .fn()
      .mockResolvedValue({ id: "custom", configurationId: null });
    const tx = {
      codebaseProject: {
        findUnique: vi.fn().mockResolvedValue({ repositoryId: "repo-1" }),
        delete: vi.fn(),
      },
      build: { findFirst: active, deleteMany: vi.fn() },
      buildConfiguration: { deleteMany: vi.fn() },
      codebaseRepositoryBuildScript: { deleteMany: vi.fn() },
    };
    getPrismaClient.mockResolvedValue({
      $transaction: vi.fn((callback) => callback(tx)),
    });
    const service = new BuildsService(control());
    await expect(service.deleteProject("project-1")).rejects.toThrow(
      "active build",
    );
    expect(tx.codebaseProject.delete).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledWith({
      where: {
        repositoryId: "repo-1",
        status: { in: ["QUEUED", "PREPARING", "RUNNING"] },
      },
    });
    active.mockResolvedValue(null);
    await expect(service.deleteProject("project-1")).resolves.toBe(true);
    expect(tx.buildConfiguration.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1" },
    });
    expect(tx.codebaseProject.delete).toHaveBeenCalledWith({
      where: { id: "project-1" },
    });
    expect(tx.build.deleteMany).not.toHaveBeenCalled();
    expect(tx.codebaseRepositoryBuildScript.deleteMany).not.toHaveBeenCalled();
  });

  test("script saves preserve omitted fields and unrelated order, and explicit empty assignments clear only this script", async () => {
    const tx = {
      buildScript: { upsert: vi.fn().mockResolvedValue({ id: "script-1" }) },
      codebaseRepository: { count: vi.fn().mockResolvedValue(1) },
      codebaseRepositoryBuildScript: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ repositoryId: "previous-repo" }]),
        deleteMany: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn().mockResolvedValue({ _max: { position: 7 } }),
        create: vi.fn(),
      },
    };
    getPrismaClient.mockResolvedValue({
      $transaction: vi.fn((callback) => callback(tx)),
    });
    const service = new BuildsService(control());
    const input = {
      id: "script-1",
      name: "Hook",
      preBuildScript: "export default () => {}",
      enabledByDefault: true,
      failureBehavior: "FAIL_BUILD" as const,
    };
    await service.saveScript(input);
    expect(tx.buildScript.upsert.mock.calls[0][0].update).not.toHaveProperty(
      "iconKey",
    );
    expect(tx.buildScript.upsert.mock.calls[0][0].update).not.toHaveProperty(
      "lockScope",
    );
    expect(tx.codebaseRepositoryBuildScript.deleteMany).not.toHaveBeenCalled();
    await service.saveScript({
      ...input,
      iconKey: "hammer",
      lockScope: "AGENT",
      repositoryIds: ["repo-1"],
    });
    expect(tx.buildScript.upsert.mock.calls.at(-1)![0].update.lockScope).toBe(
      "AGENT",
    );
    expect(tx.codebaseRepositoryBuildScript.create).toHaveBeenCalledWith({
      data: { repositoryId: "repo-1", scriptId: "script-1", position: 8 },
    });
    tx.codebaseRepository.count.mockResolvedValue(0);
    await service.saveScript({ ...input, iconKey: null, repositoryIds: [] });
    expect(
      tx.codebaseRepositoryBuildScript.deleteMany,
    ).toHaveBeenLastCalledWith({
      where: { scriptId: "script-1", repositoryId: { notIn: [] } },
    });
    expect(
      tx.buildScript.upsert.mock.calls.at(-1)![0].update.iconKey,
    ).toBeNull();
    await expect(
      service.saveScript({ ...input, repositoryIds: ["missing"] }),
    ).rejects.toThrow("Repository not found");
  });
});

describe("live build script progress", () => {
  type ProgressInput = Parameters<BuildsService["reportProgress"]>[1];
  type Execution = {
    id: string;
    buildId: string;
    phase: string;
    position: number;
    status: string;
    exitCode: number | null;
    durationMs: number | null;
    causedBuildFailure: boolean;
    outputRelativePath: string | null;
    error: string | null;
  };

  function fixture() {
    let state = {
      build: {
        id: "build-1",
        agentId: "agent-1",
        status: "PREPARING",
        startedAt: null as Date | null,
        errorCode: null as string | null,
        error: null as string | null,
      },
      executions: ["PRE_BUILD", "POST_BUILD"].map((phase): Execution => ({
        id: phase,
        buildId: "build-1",
        phase,
        position: 0,
        status: "PENDING",
        exitCode: null,
        durationMs: null,
        causedBuildFailure: false,
        outputRelativePath: null,
        error: null,
      })),
    };
    let draft = structuredClone(state);
    const events: string[] = [];
    const publishedStates: (typeof state)[] = [];
    const buildUpdate = vi.fn(async ({ data }) => {
      Object.assign(
        draft.build,
        Object.fromEntries(
          Object.entries(data).filter(([, value]) => value !== undefined),
        ),
      );
      return { ...draft.build };
    });
    const scriptFindUnique = vi.fn(async ({ where }) => {
      const key = where.buildId_phase_position;
      return (
        draft.executions.find(
          (row) =>
            row.buildId === key.buildId &&
            row.phase === key.phase &&
            row.position === key.position,
        ) ?? null
      );
    });
    const scriptUpdateMany = vi.fn(async ({ where, data }) => {
      let count = 0;
      for (const row of draft.executions) {
        if (
          row.buildId === where.buildId &&
          row.phase === where.phase &&
          row.position === where.position &&
          (!where.status || where.status.in.includes(row.status))
        ) {
          Object.assign(
            row,
            Object.fromEntries(
              Object.entries(data).filter(([, value]) => value !== undefined),
            ),
          );
          count += 1;
        }
      }
      return { count };
    });
    const transaction = {
      build: {
        findUnique: vi.fn(async () => ({ ...draft.build })),
        update: buildUpdate,
      },
      buildScriptExecution: {
        findUnique: scriptFindUnique,
        updateMany: scriptUpdateMany,
      },
    };
    getPrismaClient.mockResolvedValue({
      $transaction: vi.fn(async (callback) => {
        draft = structuredClone(state);
        events.push("begin");
        const result = await callback(transaction);
        state = draft;
        events.push("commit");
        return result;
      }),
    });
    const publish = vi
      .spyOn(agentEventBus, "publish")
      .mockImplementation((topic) => {
        if (topic === buildTopic("build-1")) {
          events.push("publish");
          publishedStates.push(structuredClone(state));
        }
      });
    return {
      service: new BuildsService(control()),
      get state() {
        return state;
      },
      events,
      publishedStates,
      publish,
      buildUpdate,
      scriptFindUnique,
      scriptUpdateMany,
    };
  }

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  test("publishes completed pre-build results together with RUNNING only after commit", async () => {
    const f = fixture();
    const completed = {
      phase: "PRE_BUILD" as const,
      position: 0,
      status: "SUCCEEDED" as const,
      exitCode: 0,
      durationMs: 125,
      causedBuildFailure: false,
      outputRelativePath: "hooks/pre/000-setup.log",
      error: null,
    };

    await f.service.reportProgress("agent-1", {
      buildId: "build-1",
      status: "RUNNING",
      scriptExecutions: [completed],
    });

    expect(f.state.build.status).toBe("RUNNING");
    expect(f.state.executions[0]).toMatchObject(completed);
    expect(f.state.executions[1].status).toBe("PENDING");
    expect(f.events).toEqual(["begin", "commit", "publish"]);
    expect(f.publishedStates).toEqual([f.state]);
    expect(f.scriptFindUnique).toHaveBeenCalledWith({
      where: {
        buildId_phase_position: {
          buildId: "build-1",
          phase: "PRE_BUILD",
          position: 0,
        },
      },
      select: { id: true },
    });
  });

  test.each(["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"] as const)(
    "retains terminal %s results when a late RUNNING report or replay arrives",
    async (status) => {
      const f = fixture();
      const result = {
        phase: "PRE_BUILD" as const,
        position: 0,
        status,
        exitCode: status === "SUCCEEDED" ? 0 : 1,
        durationMs: 125,
        error: status === "SUCCEEDED" ? null : "Hook did not succeed",
      };
      await f.service.reportProgress("agent-1", {
        buildId: "build-1",
        status: "RUNNING",
        scriptExecutions: [result],
      });
      await f.service.reportProgress("agent-1", {
        buildId: "build-1",
        status: "PREPARING",
        scriptExecutions: [{ ...result, status: "RUNNING", error: null }],
      });
      await f.service.reportProgress("agent-1", {
        buildId: "build-1",
        status: "RUNNING",
        scriptExecutions: [{ ...result, durationMs: 999 }],
      });

      expect(f.state.build.status).toBe("RUNNING");
      expect(f.state.executions[0]).toMatchObject(result);
    },
  );

  test("updates a post-build script while compilation results remain running", async () => {
    const f = fixture();
    f.state.build.status = "RUNNING";
    await f.service.reportProgress("agent-1", {
      buildId: "build-1",
      status: "RUNNING",
      scriptExecutions: [
        { phase: "POST_BUILD", position: 0, status: "RUNNING" },
      ],
    });
    expect(f.state.executions[1].status).toBe("RUNNING");
    await f.service.reportProgress("agent-1", {
      buildId: "build-1",
      status: "RUNNING",
      scriptExecutions: [
        {
          phase: "POST_BUILD",
          position: 0,
          status: "FAILED",
          exitCode: 1,
          causedBuildFailure: false,
          error: "Cleanup failed but the build may continue",
        },
      ],
    });
    expect(f.state.build.status).toBe("RUNNING");
    expect(f.state.executions[1]).toMatchObject({
      status: "FAILED",
      causedBuildFailure: false,
      exitCode: 1,
    });
  });

  test.each([undefined, null])(
    "accepts legacy progress without script updates (%s)",
    async (scriptExecutions) => {
      const f = fixture();
      const startedAt = "2026-11-04T15:00:00.000Z";
      await f.service.reportProgress("agent-1", {
        buildId: "build-1",
        status: "PREPARING",
        startedAt,
        scriptExecutions,
      });

      expect(f.state.build.startedAt).toEqual(new Date(startedAt));
      expect(f.scriptFindUnique).not.toHaveBeenCalled();
      expect(f.scriptUpdateMany).not.toHaveBeenCalled();
      expect(f.events).toEqual(["begin", "commit", "publish"]);
    },
  );

  test("rejects another agent's report before changing any execution", async () => {
    const f = fixture();
    await expect(
      f.service.reportProgress("other-agent", {
        buildId: "build-1",
        status: "RUNNING",
        scriptExecutions: [
          { phase: "PRE_BUILD", position: 0, status: "SUCCEEDED" },
        ],
      }),
    ).rejects.toThrow("Build not found for agent");
    expect(f.state.build.status).toBe("PREPARING");
    expect(f.scriptUpdateMany).not.toHaveBeenCalled();
    expect(f.buildUpdate).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  test.each([
    { phase: "INVALID", position: 0, status: "RUNNING" },
    { phase: "PRE_BUILD", position: -1, status: "RUNNING" },
    { phase: "PRE_BUILD", position: 0.5, status: "RUNNING" },
    { phase: "PRE_BUILD", position: 0, status: "PENDING" },
  ])(
    "rejects invalid execution progress %j without publishing",
    async (execution) => {
      const f = fixture();
      await expect(
        f.service.reportProgress("agent-1", {
          buildId: "build-1",
          status: "RUNNING",
          scriptExecutions: [execution],
        } as ProgressInput),
      ).rejects.toThrow("Build script execution progress is invalid");
      expect(f.state.build.status).toBe("PREPARING");
      expect(f.scriptUpdateMany).not.toHaveBeenCalled();
      expect(f.buildUpdate).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
    },
  );

  test("rejects a batch containing an unknown execution before any writes", async () => {
    const f = fixture();
    await expect(
      f.service.reportProgress("agent-1", {
        buildId: "build-1",
        status: "RUNNING",
        scriptExecutions: [
          { phase: "PRE_BUILD", position: 0, status: "SUCCEEDED" },
          { phase: "PRE_BUILD", position: 1, status: "SUCCEEDED" },
        ],
      }),
    ).rejects.toThrow("Build script execution not found");
    expect(f.state.executions.map((row) => row.status)).toEqual([
      "PENDING",
      "PENDING",
    ]);
    expect(f.state.build.status).toBe("PREPARING");
    expect(f.scriptUpdateMany).not.toHaveBeenCalled();
    expect(f.buildUpdate).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  test.each(["SUCCEEDED", "FAILED", "CANCELLED"])(
    "ignores late progress for a completed %s build",
    async (status) => {
      const f = fixture();
      f.state.build.status = status;
      await f.service.reportProgress("agent-1", {
        buildId: "build-1",
        status: "RUNNING",
        scriptExecutions: [
          { phase: "PRE_BUILD", position: 0, status: "RUNNING" },
        ],
      });

      expect(f.state.build.status).toBe(status);
      expect(f.scriptUpdateMany).not.toHaveBeenCalled();
      expect(f.buildUpdate).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
    },
  );
});

vi.mock("@/services/server-urls/server-urls.service", () => ({
  serverUrlSettingsService: {
    buildSettings: vi.fn(async (_destination, kind) => ({
      localBaseUrl: "http://127.0.0.1:3000",
      remoteBaseUrl: "https://builds.example.com",
      proxyBaseUrl: "https://aide.example.ts.net",
      selectedUrlKind: kind ?? "LOCAL",
      selectedBaseUrl:
        kind === "REMOTE"
          ? "https://builds.example.com"
          : kind === "PROXY"
            ? "https://aide.example.ts.net"
            : "http://127.0.0.1:3000",
    })),
  },
}));
