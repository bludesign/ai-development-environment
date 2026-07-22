import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  IOS_BUILD_JOB_KIND,
  IOS_BUILD_DELETE_JOB_KIND,
  IOS_DESTINATIONS_JOB_KIND,
  IOS_DEPLOY_JOB_KIND,
  IOS_RUN_DESTINATIONS_JOB_KIND,
  type BuildDestination,
} from "@ai-development-environment/agent-contract/builds";
import {
  BUILDS_CHANGED_TOPIC,
  agentEventBus,
  buildTopic,
  type AgentControlService,
} from "@/services/agent-control";

import { BuildsService } from "./builds.service";

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

function control(createJob = vi.fn().mockResolvedValue({ id: "job-1" })) {
  return {
    registerCompletionHandler: vi.fn(),
    createJob,
  } as unknown as AgentControlService;
}

describe("BuildsService", () => {
  beforeEach(() => vi.clearAllMocks());

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
    expect(JSON.parse(data.snapshotJson).configuration.parse.status).toBe(
      "UNPARSED",
    );
    expect(JSON.parse(data.snapshotJson).worktree).toMatchObject({
      codeStateHash: "state-before-build",
      hasStagedChanges: false,
      hasUnstagedChanges: false,
    });
  });

  test("captures the pre-hook code state and restores the final worktree state on completion", async () => {
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
        scriptExecutions: [],
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
          href: "/builds/build-1",
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
    expect(createInput.data.commandSummary).not.toContain("derivedDataPath");
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
    ).resolves.toEqual([destination]);
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

  test("returns generic and connected build targets from the agent preflight", async () => {
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
          destinations: [genericSimulator, genericPhysical, destination],
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
    ).resolves.toEqual([genericSimulator, genericPhysical, destination]);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: IOS_DESTINATIONS_JOB_KIND,
        payload: expect.objectContaining({ action: "BUILD" }),
      }),
    );
  });

  test("orders and paginates build-wide logs by timestamp and ID", async () => {
    const createdAt = new Date("2026-07-18T12:00:00Z");
    const findMany = vi.fn().mockResolvedValue([]);
    getPrismaClient.mockResolvedValue({
      buildLogEvent: {
        findFirst: vi.fn().mockResolvedValue({ id: "log-4", createdAt }),
        findMany,
      },
    });

    await new BuildsService(control()).logs("build-1", "log-4", 25);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        buildId: "build-1",
        OR: [
          { createdAt: { gt: createdAt } },
          { createdAt, id: { gt: "log-4" } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 25,
    });
  });

  test("reuses a deployment retry when destination metadata changes", async () => {
    const selectedDestination = { ...destination, state: "Shutdown" };
    const refreshedDestination = { ...destination, state: "Booted" };
    const buildWorktree = worktree();
    buildWorktree.codebase.agent.capabilitiesJson = JSON.stringify([
      IOS_DEPLOY_JOB_KIND,
    ]);
    const deployment = {
      id: "deployment-1",
      buildId: "build-1",
      requestId: "run-1",
      destinationJson: JSON.stringify(selectedDestination),
      destinationKey: "SIMULATOR:SIM-1",
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
          destinationType: "SIMULATOR",
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
    vi.spyOn(service, "destinationsForBuild").mockResolvedValue([
      refreshedDestination,
    ]);

    await expect(
      service.runBuild({
        buildId: "build-1",
        destinations: [selectedDestination],
        requestId: "run-1",
      }),
    ).resolves.toEqual([deployment]);

    expect(findDeployment).toHaveBeenCalledWith({
      where: {
        buildId_requestId_destinationKey: {
          buildId: "build-1",
          requestId: "run-1",
          destinationKey: "SIMULATOR:SIM-1",
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
  });

  test("redacts common credentials again before central log persistence", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    getPrismaClient.mockResolvedValue({
      build: {
        findUnique: vi.fn().mockResolvedValue({
          id: "build-1",
          agentId: "agent-1",
        }),
      },
      buildLogEvent: { upsert },
    });
    const service = new BuildsService(control());

    await service.appendLogs("agent-1", "build-1", [
      {
        scope: "BUILD",
        scopeId: "build-1",
        sequence: 0,
        phase: "XCODEBUILD",
        level: "INFO",
        stream: "STDOUT",
        message:
          "Bearer abc.def API_TOKEN=secret https://user:password@example.com",
        createdAt: new Date().toISOString(),
      },
    ]);

    const persisted = upsert.mock.calls[0]![0].create.message as string;
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toMatch(/abc\.def|API_TOKEN=secret|user:password/);
  });
});
