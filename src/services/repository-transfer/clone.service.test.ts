// @vitest-environment node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { PrismaClient } from "@/generated/prisma/client";
import { createRepositoryTransferResolvers } from "@/graphql/resolvers/repository-transfer";
import {
  AgentControlService,
  agentEventBus,
  SUPPORTED_AGENT_JOBS,
  validateJob,
} from "@/services/agent-control";
import type { RepositoryTransferService } from "./repository-transfer.service";
import {
  CODEBASE_CLONE_JOB_KIND,
  CODEBASE_CLONE_INSPECT_JOB_KIND,
} from "@ai-development-environment/agent-contract/codebases";
import {
  RepositoryCloneService,
  type RepositoryClonePreview,
} from "./clone.service";

describe("repository transfer clone persistence", () => {
  let directory: string;
  let template: string;
  let prisma: PrismaClient;
  let service: RepositoryCloneService;
  let control: AgentControlService;
  let inspectionStatus: "MISSING" | "REUSE" | "CONFLICT";
  let createJob: MockInstance<AgentControlService["createJob"]>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "aide-transfer-"));
    template = join(directory, "template.db");
    const database = new Database(template);
    database.pragma("foreign_keys = ON");
    const migrations = resolve(process.cwd(), "prisma/migrations");
    database.transaction(() => {
      for (const migration of readdirSync(migrations).toSorted()) {
        const path = join(migrations, migration, "migration.sql");
        if (existsSync(path)) database.exec(readFileSync(path, "utf8"));
      }
    })();
    database.close();
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    const path = join(directory, `${randomUUID()}.db`);
    await copyFile(template, path);
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: path }),
    });
    mocks.getPrismaClient.mockResolvedValue(prisma);
    await prisma.agent.createMany({
      data: ["agent-1", "agent-2"].map((id) => ({
        id,
        name: id,
        hostname: `${id}.test`,
        version: "1",
        osVersion: "macOS",
        architecture: "arm64",
        secretHash: id,
        capabilitiesJson: JSON.stringify([
          CODEBASE_CLONE_JOB_KIND,
          CODEBASE_CLONE_INSPECT_JOB_KIND,
        ]),
        baseRepoDirectory: "/repositories",
        lastSeenAt: new Date(),
      })),
    });
    await prisma.codebaseRepository.createMany({
      data: ["web", "ios"].map((name) => ({
        id: name,
        name,
        canonicalOrigin: `github.com/acme/${name}`,
        displayOrigin: `github.com/acme/${name}`,
      })),
    });
    control = new AgentControlService();
    const originalCreate = control.createJob.bind(control);
    inspectionStatus = "MISSING";
    createJob = vi
      .spyOn(control, "createJob")
      .mockImplementation(async (input) => {
        const job = await originalCreate(input);
        if (input.kind === CODEBASE_CLONE_INSPECT_JOB_KIND) {
          const payload = input.payload as {
            baseDirectory: string;
            relativePath: string;
          };
          return control.completeJob(
            input.agentId,
            job.id,
            "SUCCEEDED",
            {
              destinationPath: `${payload.baseDirectory}/${payload.relativePath}`,
              status: inspectionStatus,
              error:
                inspectionStatus === "CONFLICT"
                  ? "Existing unrelated folder"
                  : null,
            },
            null,
          );
        }
        return job;
      });
    service = new RepositoryCloneService(control);
  });
  afterEach(async () => {
    await prisma.$disconnect();
    vi.restoreAllMocks();
  });

  async function preview(repositoryId = "web", agentId = "agent-1") {
    return (
      await service.previewDestinations([
        {
          repositoryKey: repositoryId,
          repositoryId,
          agentId,
          remoteUrl: `https://github.com/acme/${repositoryId}.git`,
        },
      ])
    )[0]!;
  }
  async function create(
    destinations: RepositoryClonePreview[],
    requestId: string = randomUUID(),
  ) {
    return prisma.$transaction((transaction) =>
      service.createOperation(transaction, {
        requestId,
        kind: "IMPORT",
        result: { imported: true },
        destinations,
      }),
    );
  }
  function result(
    folder = "/repositories/web",
    canonicalOrigin = "github.com/acme/web",
  ) {
    return {
      exitCode: 0,
      reused: false,
      snapshot: {
        folder,
        observedOrigin: `https://${canonicalOrigin}.git`,
        canonicalOrigin,
        displayOrigin: canonicalOrigin,
        branch: "main",
        headSha: "abc",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        syncState: "IN_SYNC",
        availability: "AVAILABLE",
        error: null,
        checkedAt: new Date().toISOString(),
        fetchedAt: null,
        linkedWorktree: false,
      },
    };
  }

  test("validates and advertises both clone wire operations", () => {
    for (const kind of [
      CODEBASE_CLONE_JOB_KIND,
      CODEBASE_CLONE_INSPECT_JOB_KIND,
    ]) {
      expect(SUPPORTED_AGENT_JOBS).toContain(kind);
      expect(() =>
        validateJob(kind, {
          operationId: "operation",
          itemId: "item",
          codebaseId: "checkout",
          baseDirectory: "/repositories",
          relativePath: "web",
          remoteUrl: "https://github.com/acme/web.git",
          expectedOrigin: "github.com/acme/web",
        }),
      ).not.toThrow();
      expect(() => validateJob(kind, { folder: "/bad" })).toThrow();
    }
  });

  test("preflight returns on-disk conflicts and cleans ephemeral inspection jobs", async () => {
    inspectionStatus = "CONFLICT";
    expect(await preview()).toMatchObject({
      status: "BLOCKED",
      error: "Existing unrelated folder",
    });
    expect(await prisma.codebase.count()).toBe(0);
    expect(await prisma.agentJob.count()).toBe(0);
  });

  test("read-only coverage finds an available checkout by canonical origin and preserves its actual folder", async () => {
    await prisma.codebase.createMany({
      data: [
        {
          id: "old-missing-checkout",
          agentId: "agent-1",
          repositoryId: "web",
          folder: "/repositories/web",
          observedOrigin: "https://github.com/acme/web.git",
          availability: "MISSING",
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
        {
          id: "existing-custom-checkout",
          agentId: "agent-1",
          repositoryId: "web",
          folder: "/other-volume/customer-portal",
          observedOrigin: "git@github.com:acme/web.git",
          availability: "AVAILABLE",
        },
      ],
    });
    const coverage = await service.previewDestinations(
      ["agent-1", "agent-2"].map((agentId) => ({
        repositoryKey: "imported-web",
        agentId,
        remoteUrl: "https://github.com/Acme/Web.git",
      })),
      { inspect: false },
    );
    expect(coverage).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        repositoryId: "web",
        status: "REUSE",
        codebaseId: "existing-custom-checkout",
        destinationPath: "/other-volume/customer-portal",
      }),
      expect.objectContaining({
        agentId: "agent-2",
        repositoryId: "web",
        status: "READY",
        codebaseId: null,
        destinationPath: "/repositories/web",
      }),
    ]);
    expect(createJob).not.toHaveBeenCalled();
    expect(await prisma.agentJob.count()).toBe(0);
    expect(await prisma.codebase.count()).toBe(2);
  });

  test("read-only coverage retains an existing checkout on an offline agent without clone prerequisites", async () => {
    await prisma.codebase.create({
      data: {
        id: "offline-existing",
        agentId: "agent-1",
        repositoryId: "web",
        folder: "/original-location/customer-portal",
        observedOrigin: "git@github.com:acme/web.git",
      },
    });
    await prisma.agent.update({
      where: { id: "agent-1" },
      data: {
        disconnectedAt: new Date(),
        baseRepoDirectory: null,
        capabilitiesJson: "[]",
      },
    });
    const [coverage] = await service.previewDestinations(
      [
        {
          repositoryKey: "web",
          repositoryId: "web",
          agentId: "agent-1",
          remoteUrl: "https://github.com/acme/web.git",
        },
      ],
      { inspect: false },
    );
    expect(coverage).toMatchObject({
      status: "REUSE",
      codebaseId: "offline-existing",
      destinationPath: "/original-location/customer-portal",
      error: null,
    });
    expect(createJob).not.toHaveBeenCalled();
    expect(await prisma.agentJob.count()).toBe(0);
  });

  test.each(["MISSING", "NOT_REPOSITORY", "ORIGIN_MISMATCH", "ERROR"])(
    "read-only coverage does not mark a %s registration as an available checkout",
    async (availability) => {
      await prisma.codebase.create({
        data: {
          id: "unavailable-checkout",
          agentId: "agent-1",
          repositoryId: "web",
          folder: "/repositories/web",
          observedOrigin: "https://github.com/acme/web.git",
          availability,
        },
      });
      const [coverage] = await service.previewDestinations(
        [
          {
            repositoryKey: "web",
            repositoryId: "web",
            agentId: "agent-1",
            remoteUrl: "https://github.com/acme/web.git",
          },
        ],
        { inspect: false },
      );
      expect(coverage).toMatchObject({
        status: "READY",
        codebaseId: "unavailable-checkout",
        destinationPath: "/repositories/web",
      });
      expect(createJob).not.toHaveBeenCalled();
    },
  );

  test("blocks offline agents, unsupported agents, absent base directories and colliding paths", async () => {
    await prisma.agent.update({
      where: { id: "agent-1" },
      data: { disconnectedAt: new Date() },
    });
    expect(await preview()).toMatchObject({
      status: "BLOCKED",
      error: "Agent is offline",
    });
    await prisma.agent.update({
      where: { id: "agent-1" },
      data: { disconnectedAt: null, capabilitiesJson: "[]" },
    });
    expect(await preview()).toMatchObject({
      status: "BLOCKED",
      error: expect.stringContaining("Update"),
    });
    await prisma.agent.update({
      where: { id: "agent-1" },
      data: { baseRepoDirectory: null },
    });
    expect(await preview()).toMatchObject({
      status: "BLOCKED",
      error: expect.stringContaining("Base repository directory"),
    });
    await prisma.codebase.create({
      data: {
        id: "other",
        agentId: "agent-2",
        repositoryId: "ios",
        folder: "/repositories/web",
        observedOrigin: "https://github.com/acme/ios.git",
      },
    });
    expect(await preview("web", "agent-2")).toMatchObject({
      status: "BLOCKED",
      error: expect.stringContaining("different repository"),
    });
  });

  test("reserves pending checkout ids atomically and reuses an idempotent request", async () => {
    const destination = { ...(await preview()), codebaseId: "planned-id" };
    const operation = await create([destination], "request");
    expect(
      await prisma.codebase.findUnique({ where: { id: "planned-id" } }),
    ).toMatchObject({
      availability: "MISSING",
      statusError: "Repository clone pending",
    });
    expect((await create([destination], "request")).id).toBe(operation.id);
    await expect(
      create([{ ...destination, relativePath: "another" }], "request"),
    ).rejects.toThrow("different transfer selections");
    expect(await prisma.repositoryTransferOperation.count()).toBe(1);
    await expect(
      prisma.$transaction(async (transaction) => {
        await service.createOperation(transaction, {
          requestId: "rollback",
          kind: "SYNC",
          destinations: [
            {
              ...(await preview("ios", "agent-2")),
              codebaseId: "rollback-checkout",
            },
          ],
        });
        throw new Error("later config failure");
      }),
    ).rejects.toThrow("later config failure");
    expect(
      await prisma.codebase.findUnique({ where: { id: "rollback-checkout" } }),
    ).toBeNull();
  });

  test("finishes a no-clone import and reuses available repositories without a clone job", async () => {
    expect((await service.dispatch((await create([])).id)).status).toBe(
      "SUCCEEDED",
    );
    await prisma.codebase.create({
      data: {
        id: "existing",
        agentId: "agent-1",
        repositoryId: "web",
        folder: "/elsewhere/web",
        observedOrigin: "https://github.com/acme/web.git",
      },
    });
    inspectionStatus = "REUSE";
    const destination = await preview();
    expect(destination).toMatchObject({
      status: "REUSE",
      codebaseId: "existing",
      destinationPath: "/elsewhere/web",
    });
    const operation = await service.dispatch((await create([destination])).id);
    expect(operation).toMatchObject({
      status: "SUCCEEDED",
      items: [expect.objectContaining({ status: "REUSED" })],
    });
    expect(
      createJob.mock.calls.every(
        ([input]) => input.kind === CODEBASE_CLONE_INSPECT_JOB_KIND,
      ),
    ).toBe(true);
  });

  test("projects successful completion into the reserved checkout and emits durable progress", async () => {
    const operation = await service.dispatch(
      (await create([await preview()])).id,
    );
    expect(operation.status).toBe("RUNNING");
    const item = operation.items[0]!;
    await control.completeJob(
      item.agentId,
      item.jobId!,
      "SUCCEEDED",
      result(),
      null,
    );
    expect(await service.get(operation.id)).toMatchObject({
      status: "SUCCEEDED",
      items: [expect.objectContaining({ status: "SUCCEEDED" })],
    });
    expect(
      await prisma.codebase.findUnique({ where: { id: item.codebaseId! } }),
    ).toMatchObject({
      availability: "AVAILABLE",
      statusError: null,
      defaultBranch: "main",
    });
    await control.completeJob(
      item.agentId,
      item.jobId!,
      "SUCCEEDED",
      result(),
      null,
    );
    expect(await prisma.codebase.count()).toBe(1);
  });

  test("resolving partial clone progress does not write or publish another update", async () => {
    const operation = await service.dispatch(
      (await create([await preview("web"), await preview("ios", "agent-2")]))
        .id,
    );
    const web = operation.items.find((item) => item.repositoryId === "web")!;
    const ios = operation.items.find((item) => item.repositoryId === "ios")!;
    const resolvers = createRepositoryTransferResolvers({
      clones: service,
    } as RepositoryTransferService);
    const events = service.subscribe(operation.id);
    try {
      await control.completeJob(
        web.agentId,
        web.jobId!,
        "SUCCEEDED",
        result(),
        null,
      );
      const event = await events.next();
      expect(event.done).toBe(false);
      const before = await prisma.repositoryTransferOperation.findUniqueOrThrow(
        {
          where: { id: operation.id },
          include: { items: { orderBy: { createdAt: "asc" } } },
        },
      );
      expect(before.status).toBe("RUNNING");
      const publish = vi.spyOn(agentEventBus, "publish");
      await expect(
        resolvers.Subscription.repositoryTransferChanged.resolve(event.value),
      ).resolves.toEqual(before);
      expect(publish).not.toHaveBeenCalled();
      expect(
        await prisma.repositoryTransferOperation.findUniqueOrThrow({
          where: { id: operation.id },
          include: { items: { orderBy: { createdAt: "asc" } } },
        }),
      ).toEqual(before);

      await control.completeJob(
        ios.agentId,
        ios.jobId!,
        "SUCCEEDED",
        result("/repositories/ios", "github.com/acme/ios"),
        null,
      );
      const completed = await events.next();
      expect(completed.done).toBe(false);
      await expect(
        resolvers.Subscription.repositoryTransferChanged.resolve(
          completed.value,
        ),
      ).resolves.toMatchObject({
        status: "SUCCEEDED",
        items: [
          expect.objectContaining({ status: "SUCCEEDED" }),
          expect.objectContaining({ status: "SUCCEEDED" }),
        ],
      });
    } finally {
      await events.return?.();
    }
  });

  test("recovers completion after a crash before saving the job link without creating a second job", async () => {
    const operation = await create([await preview()]);
    const item = operation.items[0]!;
    const job = await control.createJob({
      agentId: item.agentId,
      kind: CODEBASE_CLONE_JOB_KIND,
      codebaseId: item.codebaseId,
      idempotencyKey: `repository-transfer:${item.id}`,
      payload: {
        operationId: operation.id,
        itemId: item.id,
        codebaseId: item.codebaseId,
        baseDirectory: item.baseDirectory,
        relativePath: item.relativePath,
        remoteUrl: item.remoteUrl,
        expectedOrigin: "github.com/acme/web",
      },
    });
    await prisma.agentJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        resultJson: JSON.stringify(result()),
        finishedAt: new Date(),
      },
    });
    const restarted = new RepositoryCloneService(control);
    await restarted.recover();
    expect(await restarted.get(operation.id)).toMatchObject({
      status: "SUCCEEDED",
      items: [expect.objectContaining({ jobId: job.id, status: "SUCCEEDED" })],
    });
    expect(
      await prisma.agentJob.count({ where: { kind: CODEBASE_CLONE_JOB_KIND } }),
    ).toBe(1);
    expect(
      await prisma.codebase.findUnique({ where: { id: item.codebaseId! } }),
    ).toMatchObject({ availability: "AVAILABLE" });
  });

  test("rejects a malicious success snapshot without registering a different checkout", async () => {
    const operation = await service.dispatch(
      (await create([await preview()])).id,
    );
    const item = operation.items[0]!;
    await control.completeJob(
      item.agentId,
      item.jobId!,
      "SUCCEEDED",
      result("/outside"),
      null,
    );
    expect(await service.get(operation.id)).toMatchObject({
      status: "FAILED",
      items: [
        expect.objectContaining({
          error: expect.stringContaining("different repository or destination"),
        }),
      ],
    });
    expect(
      await prisma.codebase.findUnique({ where: { id: item.codebaseId! } }),
    ).toMatchObject({ availability: "MISSING", folder: "/repositories/web" });
  });

  test("retries only failed clone destinations without replaying settings or successful jobs", async () => {
    const operation = await service.dispatch(
      (await create([await preview("web"), await preview("ios", "agent-2")]))
        .id,
    );
    const web = operation.items.find((item) => item.repositoryId === "web")!;
    const ios = operation.items.find((item) => item.repositoryId === "ios")!;
    await control.completeJob(
      web.agentId,
      web.jobId!,
      "SUCCEEDED",
      result(),
      null,
    );
    await control.completeJob(
      ios.agentId,
      ios.jobId!,
      "FAILED",
      null,
      "SSH authentication failed",
    );
    expect((await service.get(operation.id))?.status).toBe("PARTIAL");
    const retry = await service.retry(operation.id, "retry-id");
    expect(retry.items).toHaveLength(1);
    expect(retry.items[0]).toMatchObject({
      repositoryId: "ios",
      codebaseId: ios.codebaseId,
    });
    expect(retry.items[0]!.jobId).not.toBe(ios.jobId);
    expect(retry.resultJson).toBe(JSON.stringify({ retryOf: operation.id }));
    expect((await service.retry(operation.id, "retry-id")).id).toBe(retry.id);
    expect(await prisma.codebase.count()).toBe(2);
  });

  test("does not redirect a failed retry after the agent base directory changes", async () => {
    const operation = await service.dispatch(
      (await create([await preview()])).id,
    );
    const item = operation.items[0]!;
    await control.completeJob(
      item.agentId,
      item.jobId!,
      "FAILED",
      null,
      "Authentication failed",
    );
    await prisma.agent.update({
      where: { id: item.agentId },
      data: { baseRepoDirectory: "/new-repositories" },
    });
    await expect(service.retry(operation.id, "retry-moved")).rejects.toThrow(
      "review a new import or Sync",
    );
    expect(await prisma.repositoryTransferOperation.count()).toBe(1);
    expect(await prisma.codebase.count()).toBe(1);
  });
});
