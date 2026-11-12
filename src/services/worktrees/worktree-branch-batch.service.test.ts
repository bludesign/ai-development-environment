// @vitest-environment node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKTREE_BRANCH_EXPECTED_SOURCE_CAPABILITY,
  WORKTREE_BRANCH_JOB_KIND,
} from "@ai-development-environment/agent-contract/worktrees";
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
import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import type { StartWorktreeBranchBatchInput } from "./worktree-branch-batch.service";

const mock = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => mock);
import { WorktreesService } from "./worktrees.service";

let prisma: PrismaClient;
let directory: string;
let template: string;
const createJob = vi.fn(
  async (input: Parameters<AgentControlService["createJob"]>[0]) =>
    prisma.agentJob.create({
      data: {
        id: randomUUID(),
        agentId: input.agentId,
        codebaseId: input.codebaseId,
        worktreeId: input.worktreeId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        payloadJson: JSON.stringify(input.payload),
        status: "QUEUED",
        timeoutSeconds: input.timeoutSeconds ?? 600,
      },
    }),
);

function worktrees() {
  return new WorktreesService(
    {
      registerCompletionHandler: vi.fn(),
      createJob,
      getJob: (id: string) => prisma.agentJob.findUnique({ where: { id } }),
      getJobByIdempotencyKey: (agentId: string, idempotencyKey: string) =>
        prisma.agentJob.findUnique({
          where: { agentId_idempotencyKey: { agentId, idempotencyKey } },
        }),
    } as unknown as AgentControlService,
    {} as JiraService,
    {} as GitHubService,
  );
}

function select(worktreeId: string, baseBranch = "main") {
  return { worktreeId, baseBranch, expectedBranch: `feature/${worktreeId}` };
}

const input: StartWorktreeBranchBatchInput = {
  requestId: "request",
  appId: "app",
  mode: "EXISTING",
  branchName: "release",
  items: [select("first"), select("other", "develop")],
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-branch-batch-"));
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

beforeEach(async () => {
  createJob.mockClear();
  const path = join(directory, `${randomUUID()}.db`);
  await copyFile(template, path);
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  mock.getPrismaClient.mockResolvedValue(prisma);
  await prisma.codebaseRepository.create({
    data: {
      id: "repo",
      name: "Repository",
      canonicalOrigin: "github.com/acme/repo",
      displayOrigin: "repo",
    },
  });
  await prisma.app.create({
    data: {
      id: "app",
      name: "App",
      normalizedName: "app",
      repositories: { create: { repositoryId: "repo" } },
    },
  });
  for (const [agentId, baseBranch] of [
    ["one", "main"],
    ["two", "develop"],
  ] as const) {
    await prisma.agent.create({
      data: {
        id: agentId,
        name: `Agent ${agentId}`,
        hostname: agentId,
        version: "1",
        osVersion: "macOS",
        architecture: "arm64",
        capabilitiesJson: JSON.stringify([
          WORKTREE_BRANCH_JOB_KIND,
          WORKTREE_BRANCH_EXPECTED_SOURCE_CAPABILITY,
        ]),
        secretHash: agentId,
        lastSeenAt: new Date(),
      },
    });
    await prisma.codebase.create({
      data: {
        id: agentId,
        agentId,
        repositoryId: "repo",
        folder: `/repos/${agentId}`,
        observedOrigin: "repo",
        defaultBranch: baseBranch,
        localBranchesJson: JSON.stringify([baseBranch]),
        remoteBranchesJson: JSON.stringify([baseBranch, "release"]),
      },
    });
  }
  for (const [id, codebaseId] of [
    ["first", "one"],
    ["sibling", "one"],
    ["other", "two"],
  ] as const) {
    await prisma.worktree.create({
      data: {
        id,
        codebaseId,
        gitDirectory: `/repos/${codebaseId}/.git/worktrees/${id}`,
        folder: `/worktrees/${id}`,
        relativePath: id,
        branch: `feature/${id}`,
      },
    });
  }
});

afterEach(async () => {
  await prisma.$disconnect();
});

test("validates scope and one checkout per clone and reuses the exact request", async () => {
  const service = worktrees().branchBatches;
  await expect(service.start({ ...input, appId: "unrelated" })).rejects.toThrow(
    "outside this scope",
  );
  await expect(service.start({ ...input, appId: "" })).rejects.toThrow(
    "outside this scope",
  );
  await expect(service.start({ ...input, agentId: "one" })).rejects.toThrow(
    "outside this scope",
  );
  await expect(
    service.start({ ...input, items: [select("first"), select("first")] }),
  ).rejects.toThrow("only once");
  await expect(
    service.start({ ...input, items: [select("first"), select("sibling")] }),
  ).rejects.toThrow("one worktree per codebase");
  const original = await service.start(input);
  expect(await service.start(input)).toEqual(original);
  await expect(service.start({ ...input, branchName: "main" })).rejects.toThrow(
    "request ID",
  );
  expect(await service.batches({ appId: "app" })).toEqual([original]);
  expect(await service.batches({})).toEqual([]);
});

test.each(["NEW", "TICKET"] as const)(
  "%s dispatches exactly the reviewed branch across independent clones",
  async (mode) => {
    await prisma.worktree.update({
      where: { id: "first" },
      data: { hasUnstagedChanges: true },
    });
    const service = worktrees().branchBatches;
    const batch = await service.start({
      ...input,
      mode,
      branchName: "feature/AIDE-77-exact",
      ticketKey: "aide-77",
    });
    await service.reconcile();
    expect(
      createJob.mock.calls.map(([job]) => [job.worktreeId, job.payload]),
    ).toEqual(
      expect.arrayContaining([
        [
          "first",
          expect.objectContaining({
            mode: "NEW",
            candidates: [batch.branchName],
            baseBranch: "main",
            expectedBranch: "feature/first",
            stashOnFailure: false,
          }),
        ],
        [
          "other",
          expect.objectContaining({
            mode: "NEW",
            candidates: [batch.branchName],
            baseBranch: "develop",
            expectedBranch: "feature/other",
            stashOnFailure: false,
          }),
        ],
      ]),
    );
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(batch.ticketKey).toBe(mode === "TICKET" ? "AIDE-77" : null);
    expect(
      (await service.batch(batch.id))?.items.map(({ status }) => status),
    ).toEqual(["RUNNING", "RUNNING"]);
  },
);

test("guards a detached source and skips agents without source guard support", async () => {
  await prisma.worktree.update({
    where: { id: "first" },
    data: { branch: null },
  });
  await prisma.agent.update({
    where: { id: "two" },
    data: { capabilitiesJson: JSON.stringify([WORKTREE_BRANCH_JOB_KIND]) },
  });
  const service = worktrees().branchBatches;
  const batch = await service.start({
    ...input,
    items: [
      { ...select("first"), expectedBranch: null },
      select("other", "develop"),
    ],
  });
  expect(batch.items).toMatchObject([
    { status: "PENDING" },
    {
      status: "SKIPPED",
      error: "Agent must be updated to use Bulk Change Branch",
    },
  ]);

  await service.reconcile();
  expect(createJob).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      worktreeId: "first",
      payload: expect.objectContaining({ expectedBranch: null }),
    }),
  );
});

test("rechecks hidden sibling occupancy and retains independent job failures", async () => {
  const service = worktrees().branchBatches;
  const batch = await service.start(input);
  await prisma.worktree.update({
    where: { id: "sibling" },
    data: { branch: "release" },
  });
  await service.reconcile();
  expect(await service.batch(batch.id)).toMatchObject({
    items: [
      {
        status: "SKIPPED",
        error: "Branch release is checked out in another worktree",
      },
      { status: "RUNNING" },
    ],
  });
  expect(createJob).toHaveBeenCalledOnce();
  await prisma.agentJob.updateMany({
    data: {
      status: "FAILED",
      error: "Uncommitted changes would be overwritten",
    },
  });
  await service.reconcile();
  expect(await service.batch(batch.id)).toMatchObject({
    status: "COMPLETED",
    items: [
      { status: "SKIPPED" },
      { status: "FAILED", error: "Uncommitted changes would be overwritten" },
    ],
  });
});

test("lets independent clones start while a legacy clone is busy", async () => {
  const service = worktrees().branchBatches;
  const batch = await service.start(input);
  await prisma.agentJob.create({
    data: {
      id: "blocking-job",
      agentId: "one",
      codebaseId: "one",
      kind: "worktree.commit",
      payloadJson: "{}",
      idempotencyKey: "blocking-job",
      timeoutSeconds: 60,
      status: "RUNNING",
    },
  });
  await service.reconcile();
  expect(await service.batch(batch.id)).toMatchObject({
    items: [{ status: "PENDING" }, { status: "RUNNING" }],
  });
  await prisma.agentJob.update({
    where: { id: "blocking-job" },
    data: { status: "SUCCEEDED" },
  });
  await service.reconcile();
  expect(await service.batch(batch.id)).toMatchObject({
    items: [{ status: "RUNNING" }, { status: "RUNNING" }],
  });
  expect(createJob).toHaveBeenCalledTimes(2);
});

test("recovers an unlinked completed job before rechecking the source and retains its preparation warning", async () => {
  const originalService = worktrees();
  const batch = await originalService.branchBatches.start(input);
  const [first] = batch.items;
  const job = await originalService.dispatchBulkBranchChange(
    first!,
    {
      mode: "EXISTING",
      branchName: "release",
      baseBranch: "main",
      expectedBranch: "feature/first",
    },
    "app",
  );
  await prisma.agentJob.update({
    where: { id: job.id },
    data: {
      status: "SUCCEEDED",
      resultJson: JSON.stringify({
        worktree: { branch: "release" },
        preparations: [{ state: "ERROR", message: "Preparation file changed" }],
      }),
    },
  });
  await prisma.worktree.update({
    where: { id: "first" },
    data: { branch: "release" },
  });
  await prisma.worktree.update({
    where: { id: "other" },
    data: { branch: "feature/moved" },
  });
  const restarted = worktrees().branchBatches;
  await restarted.reconcile();
  const completed = await restarted.batch(batch.id);
  expect(completed).toMatchObject({
    status: "COMPLETED",
    items: [
      {
        status: "SUCCEEDED",
        jobId: job.id,
        warning: "Preparation file changed",
      },
      {
        status: "SKIPPED",
        error: "The worktree branch changed after selection",
      },
    ],
  });
  expect(createJob).toHaveBeenCalledOnce();
  expect(await restarted.batches({ appId: "app" })).toEqual([completed]);
});
