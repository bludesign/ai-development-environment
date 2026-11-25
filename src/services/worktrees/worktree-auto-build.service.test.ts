// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { OPERATION_RESOURCES_CAPABILITY } from "@ai-development-environment/agent-contract/operation-resources";
import {
  ANDROID_BUILD_DELETE_JOB_KIND,
  ANDROID_BUILD_JOB_KIND,
  AUTO_BUILD_CHECKOUT_CHANGED,
  CLEAN_WORKTREE_BUILD_CAPABILITY,
  AUTO_BUILD_READINESS_CAPABILITY,
  IOS_BUILD_JOB_KIND,
} from "@ai-development-environment/agent-contract/builds";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { AgentControlService } from "@/services/agent-control";
import { BuildsService } from "@/services/builds/builds.service";
import { WorktreeAutoBuildService } from "./worktree-auto-build.service";
import { WorktreesService } from "./worktrees.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

let directory: string;
let templateDatabasePath: string;
let databaseCount = 0;
let prisma: PrismaClient;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-auto-build-"));
  templateDatabasePath = join(directory, "template.db");
  const db = new Database(":memory:");
  try {
    for (const migration of readdirSync("prisma/migrations").sort()) {
      const sql = join("prisma/migrations", migration, "migration.sql");
      if (existsSync(sql)) db.exec(readFileSync(sql, "utf8"));
    }
    await db.backup(templateDatabasePath);
  } finally {
    db.close();
  }
});

beforeEach(async () => {
  const path = join(directory, `test-${++databaseCount}.db`);
  await copyFile(templateDatabasePath, path);
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  getPrismaClient.mockResolvedValue(prisma);
  await prisma.agent.create({
    data: {
      id: "agent",
      name: "Agent",
      hostname: "agent",
      version: "1",
      osVersion: "macOS",
      architecture: "arm64",
      secretHash: "fixture",
      lastSeenAt: new Date(),
      buildsDirectory: "/builds",
      capabilitiesJson: JSON.stringify([
        CLEAN_WORKTREE_BUILD_CAPABILITY,
        AUTO_BUILD_READINESS_CAPABILITY,
        ANDROID_BUILD_DELETE_JOB_KIND,
        ANDROID_BUILD_JOB_KIND,
        IOS_BUILD_JOB_KIND,
      ]),
    },
  });
  await prisma.codebaseRepository.create({
    data: {
      id: "repo",
      name: "Example",
      canonicalOrigin: "https://github.com/demo/example",
      displayOrigin: "https://github.com/demo/example.git",
    },
  });
  await prisma.codebase.create({
    data: {
      id: "codebase",
      agentId: "agent",
      repositoryId: "repo",
      folder: "/codebase",
      observedOrigin: "https://github.com/demo/example.git",
    },
  });
  await prisma.worktree.create({
    data: {
      id: "worktree",
      codebaseId: "codebase",
      gitDirectory: "/codebase/.git",
      folder: "/codebase",
      relativePath: ".",
      branch: "main",
      headSha: "baseline",
      lastCheckedAt: new Date(1),
    },
  });
  await prisma.codebaseProject.createMany({
    data: [
      { id: "android", repositoryId: "repo", type: "ANDROID_APP" },
      { id: "apple", repositoryId: "repo", type: "IOS_APP" },
    ],
  });
  await prisma.androidBuildConfiguration.create({
    data: {
      id: "debug",
      projectId: "android",
      name: "Debug",
      projectPath: ".",
      module: ":app",
      variant: "debug",
    },
  });
  await prisma.buildSource.create({
    data: {
      id: "xcode",
      projectId: "apple",
      kind: "PROJECT",
      relativePath: "App.xcodeproj",
    },
  });
  await prisma.buildConfiguration.create({
    data: {
      id: "archive",
      projectId: "apple",
      sourceId: "xcode",
      name: "Archive",
      scheme: "App",
      buildConfiguration: "Release",
      defaultAction: "ARCHIVE",
    },
  });
});

afterEach(async () => {
  await prisma.$disconnect();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const createJob = vi.fn(
    async (input: Parameters<AgentControlService["createJob"]>[0]) => {
      return prisma.agentJob.upsert({
        where: {
          agentId_idempotencyKey: {
            agentId: input.agentId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        create: {
          id: `job-${createJob.mock.calls.length}`,
          agentId: input.agentId,
          codebaseId: input.codebaseId,
          worktreeId: input.worktreeId,
          kind: input.kind,
          payloadJson: JSON.stringify(input.payload),
          status: "QUEUED",
          idempotencyKey: input.idempotencyKey,
          timeoutSeconds: 600,
        },
        update: {},
      });
    },
  );
  const control = {
    createJob,
    getJobByIdempotencyKey: (agentId: string, idempotencyKey: string) =>
      prisma.agentJob.findUnique({
        where: { agentId_idempotencyKey: { agentId, idempotencyKey } },
      }),
    registerCompletionHandler: vi.fn(),
  } as unknown as AgentControlService;
  const builds = new BuildsService(control);
  const publish = vi.fn();
  const service = new WorktreeAutoBuildService(builds, publish);
  const worktrees = new WorktreesService(control, {} as never, {} as never);
  const report = (
    headSha: string,
    observedAt: number,
    hasUnstagedChanges = false,
    cleanForAutoBuild = !hasUnstagedChanges,
  ) =>
    worktrees.reportActivity("agent", {
      codebaseId: "codebase",
      gitDirectory: "/codebase/.git",
      headSha,
      cleanForAutoBuild,
      hasStagedChanges: false,
      hasUnstagedChanges,
      rebaseInProgress: false,
      hasConflicts: false,
      observedAt: new Date(observedAt).toISOString(),
    });
  return { builds, service, createJob, report, publish };
}

const androidSettings = {
  worktreeId: "worktree",
  configurationId: "debug",
  platform: "ANDROID",
  destinationType: "HOST",
} as const;

const appleSettings = {
  worktreeId: "worktree",
  configurationId: "archive",
  platform: "IOS",
  destinationType: "PHYSICAL_DEVICE",
} as const;

test("baselines the current commit and queues one Android build after a newer clean observation", async () => {
  const { builds, service, createJob, report } = fixture();
  await service.configure(androidSettings);
  await report("baseline", 2);
  await service.reconcile();
  expect(createJob).not.toHaveBeenCalled();

  await report("new-head", 4, true);
  await report("new-head", 3);
  await service.reconcile();
  expect(createJob).not.toHaveBeenCalled();

  await report("new-head", 5, false, false);
  await service.reconcile();
  expect(createJob).not.toHaveBeenCalled();

  await report("new-head", 6);
  await service.reconcile();
  const restarted = new WorktreeAutoBuildService(builds, vi.fn());
  await restarted.reconcile();
  expect(createJob).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      kind: ANDROID_BUILD_JOB_KIND,
      payload: expect.objectContaining({
        headSha: "new-head",
        requireCleanWorktree: true,
      }),
    }),
  );
  const build = await prisma.build.findFirstOrThrow();
  expect(await service.get("worktree")).toMatchObject({
    lastQueuedHeadSha: "new-head",
    lastQueuedBuildId: build.id,
    lastError: null,
  });
});

test("waits for prior automatic builds after reconfiguring and uses the latest clean HEAD", async () => {
  const { service, createJob, report } = fixture();
  await service.configure(androidSettings);
  await report("android-head", 2);
  await service.reconcile();
  const first = await prisma.build.findFirstOrThrow();
  await service.configure(appleSettings);

  await report("intermediate", 3);
  await service.reconcile();
  await report("apple-head", 4);
  await service.reconcile();
  expect(createJob).toHaveBeenCalledTimes(1);

  await prisma.build.update({
    where: { id: first.id },
    data: { status: "SUCCEEDED" },
  });
  await prisma.agentJob.update({
    where: { id: first.jobId! },
    data: { status: "SUCCEEDED" },
  });
  await service.reconcile();
  expect((await service.get("worktree"))?.lastError).toBeNull();
  expect(
    await prisma.worktree.findUnique({ where: { id: "worktree" } }),
  ).toMatchObject({
    headSha: "apple-head",
    lastCheckedAt: new Date(4),
  });
  expect(createJob).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: IOS_BUILD_JOB_KIND,
      payload: expect.objectContaining({
        action: "BUILD",
        headSha: "apple-head",
        requireCleanWorktree: true,
        destination: expect.objectContaining({
          type: "PHYSICAL_DEVICE",
          generic: true,
        }),
      }),
    }),
  );
  await service.cancel("worktree");
  await report("after-disable", 5);
  await service.reconcile();
  expect(createJob).toHaveBeenCalledTimes(2);
});

test.each([-300_000, 300_000])(
  "retries a skipped checkout only after a newer clean report with an agent clock offset of %i ms",
  async (offset) => {
    const { service, createJob, report } = fixture();
    await service.configure(androidSettings);
    const observedAt = Date.now() + offset;
    await report("new-head", observedAt);
    await service.reconcile();
    const first = await prisma.build.findFirstOrThrow();
    await prisma.build.update({
      where: { id: first.id },
      data: {
        status: "FAILED",
        errorCode: AUTO_BUILD_CHECKOUT_CHANGED,
        finishedAt: new Date(),
      },
    });
    await prisma.agentJob.update({
      where: { id: first.jobId! },
      data: { status: "FAILED" },
    });
    await service.reconcile();
    expect(createJob).toHaveBeenCalledTimes(1);
    await report("new-head", observedAt + 1, false, false);
    await service.reconcile();
    expect(createJob).toHaveBeenCalledTimes(1);
    await report("new-head", observedAt + 2);
    await service.reconcile();
    expect((await service.get("worktree"))?.lastError).toBeNull();
    expect(
      await prisma.worktree.findUnique({ where: { id: "worktree" } }),
    ).toMatchObject({
      headSha: "new-head",
      lastCheckedAt: new Date(observedAt + 2),
    });
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(await service.get("worktree")).not.toMatchObject({
      lastQueuedBuildId: first.id,
    });
  },
);

test("queues a fresh build for a revisited commit after deleting the latest build", async () => {
  const { builds, service, createJob, report } = fixture();
  await service.configure(androidSettings);
  await report("first", 2);
  await service.reconcile();
  const first = await prisma.build.findFirstOrThrow();
  await prisma.build.update({
    where: { id: first.id },
    data: { status: "SUCCEEDED" },
  });
  await prisma.agentJob.update({
    where: { id: first.jobId! },
    data: { status: "SUCCEEDED" },
  });
  await report("second", 3);
  await service.reconcile();
  const second = await prisma.build.findFirstOrThrow({
    where: { id: { not: first.id } },
  });
  await prisma.build.update({
    where: { id: second.id },
    data: { status: "SUCCEEDED" },
  });
  await prisma.agentJob.update({
    where: { id: second.jobId! },
    data: { status: "SUCCEEDED" },
  });
  await builds.deleteBuilds([second.id]);
  expect((await service.get("worktree"))?.lastQueuedBuildId).toBeNull();

  await report("first", 4);
  await service.reconcile();
  await service.reconcile();
  const latest = await prisma.build.findFirstOrThrow({
    where: { autoBuildRules: { some: { worktreeId: "worktree" } } },
  });
  expect(latest.id).not.toBe(first.id);
  expect(latest.requestId).not.toBe(first.requestId);
  expect(latest.jobId).not.toBe(first.jobId);
  const buildJobs = createJob.mock.calls.filter(
    ([job]) => job.kind === ANDROID_BUILD_JOB_KIND,
  );
  expect(buildJobs).toHaveLength(3);
});

test("keeps a dispatch error with its attempt and clears it after a fresh observation succeeds", async () => {
  const { service, createJob, report } = fixture();
  await service.configure(androidSettings);
  await report("new-head", 2);
  createJob.mockRejectedValueOnce(new Error("Dispatch failed"));
  await service.reconcile();
  expect(await service.get("worktree")).toMatchObject({
    queuedBuildCount: 1,
    lastError: "Dispatch failed",
  });

  await report("new-head", 3);
  await service.reconcile();
  expect(await service.get("worktree")).toMatchObject({
    queuedBuildCount: 2,
    lastError: null,
  });
  expect(createJob).toHaveBeenCalledTimes(2);
});

test("queues only the repository's enabled-by-default scripts on automatic Apple builds", async () => {
  const { service, createJob, report } = fixture();
  for (const [position, id] of ["optional", "default"].entries()) {
    await prisma.buildScript.create({
      data: {
        id,
        name: id,
        preBuildScript: "echo prepare",
        enabledByDefault: id === "default",
        repositories: { create: { repositoryId: "repo", position } },
      },
    });
  }
  await service.configure(appleSettings);
  await report("new-head", 2);
  await service.reconcile();

  expect(createJob).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        scripts: [expect.objectContaining({ id: "default", position: 1 })],
      }),
    }),
  );
  const executions = await prisma.buildScriptExecution.findMany();
  expect(executions.map(({ scriptId }) => scriptId)).toEqual(["default"]);
});

test("reattaches an existing job when a restart interrupted automatic submission", async () => {
  const { builds, service, createJob, report } = fixture();
  await service.configure(androidSettings);
  await report("new-head", 2);
  await service.reconcile();
  const build = await prisma.build.findFirstOrThrow();
  const job = await prisma.agentJob.findUniqueOrThrow({
    where: { id: build.jobId! },
  });
  await prisma.build.update({
    where: { id: build.id },
    data: { jobId: null, queuePayloadJson: job.payloadJson },
  });
  // A pre-upgrade agent can finish this captured guarded job, but cannot
  // advertise strict readiness or enable a rule for future revisions.
  await prisma.worktree.update({
    where: { id: "worktree" },
    data: { cleanForAutoBuild: false },
  });
  await prisma.agent.update({
    where: { id: "agent" },
    data: {
      capabilitiesJson: JSON.stringify([
        CLEAN_WORKTREE_BUILD_CAPABILITY,
        ANDROID_BUILD_JOB_KIND,
      ]),
    },
  });
  await expect(service.configure(androidSettings)).rejects.toThrow(
    "Update the build agent",
  );

  await new WorktreeAutoBuildService(builds, vi.fn()).reconcile();
  expect(createJob).toHaveBeenCalledTimes(1);
  expect(await prisma.agentJob.count()).toBe(1);
  expect(
    await prisma.build.findUniqueOrThrow({ where: { id: build.id } }),
  ).toMatchObject({
    jobId: job.id,
    queuePayloadJson: null,
  });
});

test.each([
  { settings: appleSettings, branch: "main" },
  { settings: androidSettings, branch: "main" },
  { settings: androidSettings, branch: null },
])(
  "retries a $settings.platform checkout rejected at claim time after switching from $branch on the same commit",
  async ({ settings, branch }) => {
    const control = new AgentControlService();
    const service = new WorktreeAutoBuildService(
      new BuildsService(control),
      vi.fn(),
    );
    const { report } = fixture();
    await prisma.agent.update({
      where: { id: "agent" },
      data: {
        capabilitiesJson: JSON.stringify([
          CLEAN_WORKTREE_BUILD_CAPABILITY,
          AUTO_BUILD_READINESS_CAPABILITY,
          IOS_BUILD_JOB_KIND,
          ANDROID_BUILD_JOB_KIND,
          OPERATION_RESOURCES_CAPABILITY,
        ]),
      },
    });
    await prisma.worktree.update({
      where: { id: "worktree" },
      data: { branch },
    });
    await service.configure(settings);
    await report("next", 2);
    await service.reconcile();
    const first = await prisma.build.findFirstOrThrow();
    await prisma.worktree.update({
      where: { id: "worktree" },
      data: { branch: "other", lastCheckedAt: new Date(3) },
    });
    await expect(
      control.claimJob("agent", first.jobId!, "token"),
    ).rejects.toThrow("branch or HEAD changed");
    expect(
      await prisma.build.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({
      status: "CANCELLED",
      errorCode: AUTO_BUILD_CHECKOUT_CHANGED,
    });
    await service.reconcile();
    const next = await prisma.build.findFirstOrThrow({
      where: { id: { not: first.id } },
    });
    expect(
      JSON.parse(
        (
          await prisma.agentJob.findUniqueOrThrow({
            where: { id: next.jobId! },
          })
        ).payloadJson,
      ),
    ).toMatchObject({ branch: "other", headSha: "next" });
  },
);

test.each(["dirty", "missing", "purged", "disabled"] as const)(
  "settles an interrupted submission when the worktree is %s without dispatching a stale job",
  async (change) => {
    const { service, report } = fixture();
    await service.configure(androidSettings);
    await report("next", 2);
    await service.reconcile();
    const build = await prisma.build.findFirstOrThrow();
    const job = await prisma.agentJob.findUniqueOrThrow({
      where: { id: build.jobId! },
    });
    await prisma.build.update({
      where: { id: build.id },
      data: { jobId: null, queuePayloadJson: job.payloadJson },
    });
    await prisma.agentJob.delete({ where: { id: job.id } });
    if (change === "purged") {
      await prisma.worktree.delete({ where: { id: "worktree" } });
    } else if (change === "missing") {
      await prisma.worktree.update({
        where: { id: "worktree" },
        data: { missingAt: new Date() },
      });
    } else {
      if (change === "disabled") await service.cancel("worktree");
      await report("next", 3, true);
    }
    await service.reconcile();
    expect(
      await prisma.build.findUniqueOrThrow({ where: { id: build.id } }),
    ).toMatchObject({
      status: "CANCELLED",
      errorCode: AUTO_BUILD_CHECKOUT_CHANGED,
      queuePayloadJson: null,
    });
    expect(await prisma.agentJob.count()).toBe(0);
    if (change === "dirty") {
      // An initial dispatcher arriving after recovery cannot recreate the cancelled job.
      await expect(
        new AgentControlService().createJob({
          agentId: job.agentId,
          codebaseId: job.codebaseId,
          worktreeId: job.worktreeId,
          kind: job.kind,
          payload: JSON.parse(job.payloadJson),
          idempotencyKey: job.idempotencyKey,
        }),
      ).rejects.toThrow();
      expect(await prisma.agentJob.count()).toBe(0);
      await report("next", 4);
      await service.reconcile();
      expect(await prisma.agentJob.count()).toBe(1);
    }
  },
);

test("recovers a completed durable job after its worktree has been purged", async () => {
  const { service, report } = fixture();
  await service.configure(androidSettings);
  await report("next", 2);
  await service.reconcile();
  const build = await prisma.build.findFirstOrThrow();
  const job = await prisma.agentJob.update({
    where: { id: build.jobId! },
    data: { status: "SUCCEEDED" },
  });
  await prisma.build.update({
    where: { id: build.id },
    data: { jobId: null, queuePayloadJson: job.payloadJson },
  });
  await prisma.worktree.delete({ where: { id: "worktree" } });
  await service.reconcile();
  expect(
    await prisma.build.findUniqueOrThrow({ where: { id: build.id } }),
  ).toMatchObject({
    status: "SUCCEEDED",
    jobId: job.id,
    queuePayloadJson: null,
  });
  expect(await prisma.agentJob.count()).toBe(1);
});

test("requires a saved configuration, compatible destination, and capable agent", async () => {
  const { service, createJob } = fixture();
  await expect(
    service.configure({ ...androidSettings, configurationId: "missing" }),
  ).rejects.toThrow("configuration is unavailable");
  await expect(
    service.configure({ ...appleSettings, destinationType: "LOCAL_MAC" }),
  ).rejects.toThrow("generic destination");
  await prisma.agent.update({
    where: { id: "agent" },
    data: { capabilitiesJson: JSON.stringify([ANDROID_BUILD_JOB_KIND]) },
  });
  await expect(service.configure(androidSettings)).rejects.toThrow(
    "Update the build agent",
  );
  expect(createJob).not.toHaveBeenCalled();
});
