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

  test("returns generic build targets without queueing an agent preflight", async () => {
    const createJob = vi.fn();
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(worktree()) },
      buildConfiguration: {
        findUnique: vi.fn().mockResolvedValue(configuration()),
      },
    });
    const service = new BuildsService(control(createJob));

    await expect(
      service.destinations({
        worktreeId: "worktree-1",
        configurationId: "configuration-1",
        action: "BUILD",
        requestId: "generic-destinations",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ type: "SIMULATOR", generic: true }),
      expect.objectContaining({ type: "PHYSICAL_DEVICE", generic: true }),
    ]);
    expect(createJob).not.toHaveBeenCalled();
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
