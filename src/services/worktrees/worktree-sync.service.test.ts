// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
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
import { CodebaseBusyError } from "@/lib/codebase-busy";
import type { AgentControlService } from "@/services/agent-control";
import type { WorktreesService } from "./worktrees.service";

const mock = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => mock);
import { WorktreeSyncService } from "./worktree-sync.service";

let prisma: PrismaClient;
let directory: string;
let template: string;
let databaseCount = 0;
const publishAutomationChange = vi.fn();
const createAutoSyncJob = vi.fn();
const worktrees = {
  ticketKeyForWorktree: vi.fn().mockResolvedValue("APP-1"),
  publishAutomationChange,
  createAutoSyncJob,
} as unknown as WorktreesService;
const control = {
  registerCompletionObserver: vi.fn(),
  registerConnectionHandler: vi.fn(),
} as unknown as AgentControlService;

const service = () => new WorktreeSyncService(worktrees, control);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-bulk-sync-"));
  template = join(directory, "template.db");
  const db = new Database(":memory:");
  try {
    for (const migration of readdirSync("prisma/migrations").sort()) {
      const path = join("prisma/migrations", migration, "migration.sql");
      if (existsSync(path)) db.exec(readFileSync(path, "utf8"));
    }
    await db.backup(template);
  } finally {
    db.close();
  }
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterEach(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  vi.clearAllMocks();
  const path = join(directory, `test-${++databaseCount}.db`);
  await copyFile(template, path);
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  mock.getPrismaClient.mockResolvedValue(prisma);
  for (const id of ["one", "two"]) {
    await prisma.agent.create({
      data: {
        id,
        name: `Agent ${id}`,
        hostname: id,
        version: "1",
        osVersion: "macOS",
        architecture: "arm64",
        capabilitiesJson: '["worktree.auto-sync","worktree.prepare"]',
        secretHash: id,
        lastSeenAt: new Date(),
      },
    });
    await prisma.codebaseRepository.create({
      data: {
        id,
        name: `Repo ${id}`,
        canonicalOrigin: `github.com/acme/${id}`,
        displayOrigin: id,
      },
    });
    await prisma.codebase.create({
      data: {
        id,
        agentId: id,
        repositoryId: id,
        folder: `/repos/${id}`,
        observedOrigin: id,
        defaultBranch: "main",
      },
    });
  }
  for (const [id, codebaseId] of [
    ["first", "one"],
    ["second", "one"],
    ["other", "two"],
  ]) {
    await prisma.worktree.create({
      data: {
        id: id!,
        codebaseId: codebaseId!,
        gitDirectory: `/repos/${codebaseId}/.git/worktrees/${id}`,
        folder: `/worktrees/${id}`,
        relativePath: id!,
        branch: `feature/${id}`,
        upstream: `origin/feature/${id}`,
        baseBehind: 3,
      },
    });
  }
  createAutoSyncJob.mockImplementation(
    async (id: string, _phase: string, branch: string, itemId: string) => {
      const target = await prisma.worktree.findUniqueOrThrow({
        where: { id },
        include: { codebase: true },
      });
      return prisma.agentJob.create({
        data: {
          id: `job-${itemId}`,
          agentId: target.codebase.agentId,
          codebaseId: target.codebaseId,
          worktreeId: id,
          kind: "worktree.auto-sync",
          payloadJson: JSON.stringify({ expectedBranch: branch }),
          status: "QUEUED",
          idempotencyKey: `worktree:auto-sync:sync:${itemId}:${id}`,
          timeoutSeconds: 600,
        },
      });
    },
  );
});

async function complete(
  jobId: string,
  outcome = "SYNCED",
  status = "SUCCEEDED",
) {
  await prisma.agentJob.update({
    where: { id: jobId },
    data: {
      status,
      resultJson: JSON.stringify({ outcome }),
      finishedAt: new Date(),
      error: status === "FAILED" ? "Push was rejected" : null,
    },
  });
}

test("creates idempotent immutable snapshots and rejects request ID reuse for another selection", async () => {
  const sync = service();
  await prisma.jiraCachedTicket.create({
    data: {
      issueKey: "APP-1",
      projectKey: "APP",
      summaryJson: JSON.stringify({
        fields: { summary: "Review this feature" },
      }),
    },
  });
  const input = {
    requestId: "batch",
    worktreeIds: ["first", "first", "second"],
  };
  const batch = await sync.start(input);
  expect(batch.items).toHaveLength(2);
  expect(batch.items[0]).toMatchObject({
    branch: "feature/first",
    baseBranch: "main",
    agentName: "Agent one",
    repositoryName: "Repo one",
    status: "PENDING",
    ticketKey: "APP-1",
    ticketTitle: "Review this feature",
    baseBehind: 3,
  });
  expect((await sync.start(input)).id).toBe(batch.id);
  expect(
    (await sync.start({ ...input, worktreeIds: ["second", "first"] })).id,
  ).toBe(batch.id);
  await expect(
    sync.start({ requestId: "batch", worktreeIds: ["other"] }),
  ).rejects.toThrow("already used");
  expect(await prisma.worktreeSyncBatch.count()).toBe(1);
});

test("validates selected app and global agent scope", async () => {
  await prisma.app.create({
    data: { id: "app", name: "App", normalizedName: "app" },
  });
  await prisma.appRepository.create({
    data: { appId: "app", repositoryId: "one" },
  });
  await expect(
    service().start({
      requestId: "outside-app",
      worktreeIds: ["other"],
      appId: "app",
    }),
  ).rejects.toThrow("outside the page scope");
  await expect(
    service().start({
      requestId: "outside-agent",
      worktreeIds: ["first"],
      agentId: "two",
    }),
  ).rejects.toThrow("outside the page scope");
  const batch = await service().start({
    requestId: "app",
    worktreeIds: ["first"],
    appId: "app",
    agentId: "one",
  });
  expect(batch).toMatchObject({ appId: "app", agentId: "one" });
  expect((await service().active("app")).map((entry) => entry.id)).toEqual([
    batch.id,
  ]);
  const global = await service().start({
    requestId: "global",
    worktreeIds: ["second"],
  });
  expect((await service().active("app")).map((entry) => entry.id)).toContain(
    global.id,
  );
  expect(await service().active("another-app")).toEqual([]);
});

test("serializes each codebase across batches while independent codebases progress", async () => {
  const sync = service();
  const first = await sync.start({
    requestId: "one",
    worktreeIds: ["first", "other"],
  });
  const second = await sync.start({
    requestId: "two",
    worktreeIds: ["second"],
  });
  await sync.reconcile();
  expect(createAutoSyncJob.mock.calls.map((args) => args[0]).sort()).toEqual([
    "first",
    "other",
  ]);
  expect((await sync.batch(second.id))?.items[0]?.status).toBe("PENDING");
  const running = await sync.batch(first.id);
  await complete(
    running!.items.find((item) => item.worktreeId === "first")!.jobId!,
  );
  await sync.reconcile();
  expect(createAutoSyncJob.mock.calls.map((args) => args[0])).toContain(
    "second",
  );
  expect((await sync.batch(second.id))?.items[0]?.status).toBe("RUNNING");
});

test("recovers an inserted job without item linkage before checking changed eligibility", async () => {
  const sync = service();
  const batch = await sync.start({
    requestId: "crash",
    worktreeIds: ["first"],
  });
  const item = batch.items[0]!;
  const job = await createAutoSyncJob(
    item.worktreeId,
    "SYNC",
    item.branch,
    item.id,
    false,
  );
  createAutoSyncJob.mockClear();
  await prisma.worktree.update({
    where: { id: "first" },
    data: { hasUnstagedChanges: true },
  });
  await service().reconcile();
  expect(createAutoSyncJob).not.toHaveBeenCalled();
  expect((await sync.batch(batch.id))?.items[0]).toMatchObject({
    status: "RUNNING",
    jobId: job.id,
  });
  await complete(job.id);
  await service().reconcile();
  expect(await sync.batch(batch.id)).toMatchObject({
    status: "COMPLETED",
    items: [{ status: "SUCCEEDED" }],
  });
});

test.each([
  ["branch", { branch: "changed" }, "identity"],
  ["base", { baseBranchOverride: "release" }, "identity"],
  ["path", { folder: "/moved" }, "identity"],
  ["dirty", { hasUnstagedChanges: true }, "Stash or commit"],
  ["conflicts", { hasConflicts: true }, "conflicts"],
  ["missing", { missingAt: new Date() }, "unavailable"],
] as const)(
  "skips worktrees that become %s before dispatch",
  async (_name, data, reason) => {
    const sync = service();
    const batch = await sync.start({
      requestId: "changed",
      worktreeIds: ["first"],
    });
    await prisma.worktree.update({ where: { id: "first" }, data });
    await sync.reconcile();
    const result = await sync.batch(batch.id);
    expect(result).toMatchObject({
      status: "COMPLETED",
      items: [{ status: "SKIPPED", error: expect.stringContaining(reason) }],
    });
    expect(createAutoSyncJob).not.toHaveBeenCalled();
  },
);

test("keeps deleted worktrees in batch history and continues after failure", async () => {
  const sync = service();
  const batch = await sync.start({
    requestId: "deleted",
    worktreeIds: ["first", "second"],
  });
  await prisma.worktree.delete({ where: { id: "first" } });
  await sync.reconcile();
  const result = await sync.batch(batch.id);
  expect(result?.items).toMatchObject([
    { worktreeId: "first", status: "SKIPPED", error: "Worktree was deleted" },
    { worktreeId: "second", status: "RUNNING" },
  ]);
  await complete(result!.items[1]!.jobId!, "", "FAILED");
  await sync.reconcile();
  expect(await sync.batch(batch.id)).toMatchObject({
    status: "COMPLETED",
    items: [
      { status: "SKIPPED" },
      { status: "FAILED", error: "Push was rejected" },
    ],
  });
});

test.each(["CONFLICT", "PREPARATION_CONFLICT"])(
  "projects %s as attention required and continues next worktree",
  async (outcome) => {
    const sync = service();
    const batch = await sync.start({
      requestId: "conflict",
      worktreeIds: ["first", "second"],
    });
    await sync.reconcile();
    const running = await sync.batch(batch.id);
    await complete(running!.items[0]!.jobId!, outcome);
    await sync.reconcile();
    expect((await sync.batch(batch.id))?.items).toMatchObject([
      { status: "ATTENTION_REQUIRED" },
      { status: "RUNNING" },
    ]);
    expect(createAutoSyncJob).toHaveBeenLastCalledWith(
      "second",
      "SYNC",
      "feature/second",
      expect.any(String),
      false,
      expect.objectContaining({ branch: "feature/second", baseBranch: "main" }),
    );
  },
);

test("busy lanes wait without failing, then resume on a new runtime", async () => {
  const sync = service();
  const batch = await sync.start({ requestId: "busy", worktreeIds: ["first"] });
  createAutoSyncJob.mockRejectedValueOnce(new CodebaseBusyError());
  await sync.reconcile();
  expect((await sync.batch(batch.id))?.items[0]?.status).toBe("PENDING");
  await service().reconcile();
  expect((await sync.batch(batch.id))?.items[0]?.status).toBe("RUNNING");
});

test("skips offline or already current selections and completes without dispatch", async () => {
  await prisma.agent.update({
    where: { id: "one" },
    data: { disconnectedAt: new Date() },
  });
  await prisma.worktree.update({
    where: { id: "other" },
    data: { baseBehind: 0 },
  });
  const batch = await service().start({
    requestId: "blocked",
    worktreeIds: ["first", "other"],
  });
  expect(batch).toMatchObject({
    status: "COMPLETED",
    items: [
      { status: "SKIPPED", error: "Agent is offline" },
      { status: "SKIPPED", error: "Worktree is already up to date" },
    ],
  });
  expect(createAutoSyncJob).not.toHaveBeenCalled();
});

test("recovers a submitted job when delivery reports an error after insertion", async () => {
  const sync = service();
  const batch = await sync.start({
    requestId: "delivery",
    worktreeIds: ["first"],
  });
  const insert = createAutoSyncJob.getMockImplementation()!;
  createAutoSyncJob.mockImplementationOnce(async (...args) => {
    await insert(...args);
    throw new Error("Delivery interrupted");
  });
  await sync.reconcile();
  expect((await sync.batch(batch.id))?.items[0]).toMatchObject({
    status: "RUNNING",
    error: null,
  });
  expect(await prisma.agentJob.count()).toBe(1);
  expect(createAutoSyncJob).toHaveBeenCalledTimes(1);
});

test.each(["null", '"string"', "[]", "{", '{"outcome":"unexpected"}'])(
  "fails closed for malformed or unknown job result %s",
  async (resultJson) => {
    const sync = service();
    const batch = await sync.start({
      requestId: "malformed",
      worktreeIds: ["first"],
    });
    await sync.reconcile();
    const item = (await sync.batch(batch.id))!.items[0]!;
    await prisma.agentJob.update({
      where: { id: item.jobId! },
      data: { status: "SUCCEEDED", resultJson },
    });
    await sync.reconcile();
    expect(await sync.batch(batch.id)).toMatchObject({
      status: "COMPLETED",
      items: [
        { status: "FAILED", error: expect.stringContaining("unknown result") },
      ],
    });
  },
);
