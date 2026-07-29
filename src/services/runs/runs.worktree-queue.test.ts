// @vitest-environment node
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
} from "vitest";

const mocks = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { PrismaClient } from "@/generated/prisma/client";
import { emptyWorkflowDefinition } from "@/lib/workflows/definition";
import { WorkflowEventsService } from "@/services/workflows/workflow-events.service";
import { WorkflowsService } from "@/services/workflows/workflows.service";

import { RunsService } from "./runs.service";

describe("durable worktree run queues", () => {
  let templateDirectory: string;
  let templateDatabasePath: string;
  let directory: string;
  let prisma: InstanceType<typeof PrismaClient>;
  let service: RunsService;

  beforeAll(async () => {
    templateDirectory = await mkdtemp(
      join(tmpdir(), "aide-worktree-queue-template-"),
    );
    templateDatabasePath = join(templateDirectory, "template.db");
    const database = new Database(templateDatabasePath);
    const migrationsRoot = resolve(process.cwd(), "prisma/migrations");
    for (const migration of readdirSync(migrationsRoot).toSorted()) {
      const path = join(migrationsRoot, migration, "migration.sql");
      if (existsSync(path)) database.exec(readFileSync(path, "utf8"));
    }
    database.close();
  }, 60_000);

  afterAll(async () => {
    await rm(templateDirectory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aide-worktree-queue-"));
    const databasePath = join(directory, "test.db");
    await copyFile(templateDatabasePath, databasePath);

    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: databasePath }),
    });
    mocks.getPrismaClient.mockResolvedValue(prisma);
    await prisma.agent.create({
      data: {
        id: "agent-1",
        name: "Queue Agent",
        hostname: "queue-agent.local",
        version: "1.0.0",
        osVersion: "macOS",
        architecture: "arm64",
        capabilitiesJson: JSON.stringify(["runs.provider.codex"]),
        secretHash: "queue-agent-secret",
        heartbeatIntervalSeconds: 30,
        lastSeenAt: new Date(),
      },
    });
    await prisma.codebaseRepository.create({
      data: {
        id: "repository-1",
        canonicalOrigin: "https://example.com/queue.git",
        displayOrigin: "example/queue",
        name: "queue",
      },
    });
    await prisma.codebase.create({
      data: {
        id: "codebase-1",
        repositoryId: "repository-1",
        agentId: "agent-1",
        folder: "/tmp/queue",
        observedOrigin: "https://example.com/queue.git",
        branch: "main",
      },
    });
    await prisma.worktree.create({
      data: {
        id: "worktree-1",
        codebaseId: "codebase-1",
        gitDirectory: "/tmp/queue/.git",
        folder: "/tmp/queue",
        relativePath: ".",
        primary: true,
        branch: "main",
      },
    });
    service = new RunsService();
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const input = (
    kind: "PLAN" | "SESSION",
    prompt: string,
    worktreeConcurrencyLimit?: number,
  ) => ({
    kind,
    worktreeId: "worktree-1",
    provider: "CODEX",
    model: "gpt-test",
    prompt,
    worktreeConcurrencyLimit,
  });

  test("queues a second default Session, hides its command, and promotes it FIFO", async () => {
    const first = await service.create(input("SESSION", "First session"));
    const second = await service.create(input("SESSION", "Second session"));

    expect(first).toMatchObject({
      status: "IN_PROGRESS",
      worktreeConcurrencyLimit: 1,
    });
    expect(second).toMatchObject({
      status: "QUEUED",
      phase: "WAITING_FOR_WORKTREE",
      worktreeConcurrencyLimit: 1,
    });
    await expect(prisma.worktreeRunLease.count()).resolves.toBe(1);

    const visible = await service.pendingCommands("agent-1");
    expect(visible.map(({ runId }) => runId)).toEqual([first!.id]);
    const firstCommand = visible[0]!;
    await service.claimCommand("agent-1", firstCommand.id);
    const attempt = await service.beginAttempt(
      "agent-1",
      first!.id,
      "native-first",
    );
    await service.finishAttempt("agent-1", attempt.id, {
      status: "COMPLETED",
      finalOutput: "Finished",
    });

    await expect(service.get(second!.id)).resolves.toMatchObject({
      status: "IN_PROGRESS",
      phase: "QUEUED",
    });
    await expect(
      prisma.worktreeRunLease.findMany({
        select: { runId: true },
        orderBy: { acquiredAt: "asc" },
      }),
    ).resolves.toEqual([{ runId: second!.id }]);
    const promotedCommands = await service.pendingCommands("agent-1");
    expect(promotedCommands.map(({ runId }) => runId)).toContain(second!.id);
  });

  test("serializes concurrent admissions to one default Session slot", async () => {
    const runs = await Promise.all([
      service.create(input("SESSION", "Concurrent first")),
      service.create(input("SESSION", "Concurrent second")),
    ]);

    expect(runs.map((run) => run?.status).toSorted()).toEqual([
      "IN_PROGRESS",
      "QUEUED",
    ]);
    await expect(prisma.worktreeRunLease.count()).resolves.toBe(1);
    await expect(
      prisma.agentRun.findMany({
        select: { status: true, phase: true },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { status: "IN_PROGRESS", phase: "QUEUED" },
        { status: "QUEUED", phase: "WAITING_FOR_WORKTREE" },
      ]),
    );
  });

  test("keeps Plan and Session pools separate and allows unlimited Plans", async () => {
    const session = await service.create(input("SESSION", "Session"));
    const firstPlan = await service.create(input("PLAN", "First plan"));
    const secondPlan = await service.create(input("PLAN", "Second plan"));

    expect(session).toMatchObject({
      status: "IN_PROGRESS",
      worktreeConcurrencyLimit: 1,
    });
    expect(firstPlan).toMatchObject({
      status: "IN_PROGRESS",
      worktreeConcurrencyLimit: 0,
    });
    expect(secondPlan).toMatchObject({
      status: "IN_PROGRESS",
      worktreeConcurrencyLimit: 0,
    });
    await expect(prisma.worktreeRunLease.count()).resolves.toBe(3);
  });

  test("queues excess finite Plans without consuming Session capacity", async () => {
    const firstPlan = await service.create(input("PLAN", "First plan", 1));
    const secondPlan = await service.create(input("PLAN", "Second plan", 1));
    const session = await service.create(input("SESSION", "Session"));

    expect(firstPlan?.status).toBe("IN_PROGRESS");
    expect(secondPlan).toMatchObject({
      status: "QUEUED",
      phase: "WAITING_FOR_WORKTREE",
    });
    expect(session?.status).toBe("IN_PROGRESS");
    await expect(
      prisma.worktreeRunLease.findMany({ select: { runId: true } }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { runId: firstPlan!.id },
        { runId: session!.id },
      ]),
    );
  });

  test("treats a zero Session limit as unlimited", async () => {
    const first = await service.create(input("SESSION", "First session"));
    const second = await service.create(
      input("SESSION", "Unlimited second", 0),
    );
    const third = await service.create(input("SESSION", "Unlimited third", 0));

    expect([first?.status, second?.status, third?.status]).toEqual([
      "IN_PROGRESS",
      "IN_PROGRESS",
      "IN_PROGRESS",
    ]);
    await expect(prisma.worktreeRunLease.count()).resolves.toBe(3);
  });

  test("supports finite and unlimited Session limits without overtaking", async () => {
    const first = await service.create(input("SESSION", "First session", 2));
    const second = await service.create(input("SESSION", "Second session", 2));
    const blockedHead = await service.create(
      input("SESSION", "Blocked session", 1),
    );
    const unlimitedLater = await service.create(
      input("SESSION", "Unlimited but later", 0),
    );

    expect(first?.status).toBe("IN_PROGRESS");
    expect(second?.status).toBe("IN_PROGRESS");
    expect(blockedHead?.status).toBe("QUEUED");
    expect(unlimitedLater?.status).toBe("QUEUED");
    await expect(
      prisma.worktreeRunLease.findMany({
        select: { runId: true },
        orderBy: { acquiredAt: "asc" },
      }),
    ).resolves.toHaveLength(2);
  });

  test("keeps paused runs in their slots and promotes after terminal failure", async () => {
    const first = await service.create(input("SESSION", "Pause this"));
    const second = await service.create(input("SESSION", "Wait behind it"));
    const firstAttempt = await service.beginAttempt("agent-1", first!.id);

    await service.finishAttempt("agent-1", firstAttempt.id, {
      status: "PAUSED",
    });

    await expect(service.get(second!.id)).resolves.toMatchObject({
      status: "QUEUED",
      phase: "WAITING_FOR_WORKTREE",
    });
    await expect(
      prisma.worktreeRunLease.findUnique({ where: { runId: first!.id } }),
    ).resolves.not.toBeNull();

    await service.lifecycle(first!.id, "CONTINUE");
    await expect(
      prisma.worktreeRunLease.findUnique({ where: { runId: first!.id } }),
    ).resolves.not.toBeNull();
    const secondAttempt = await service.beginAttempt("agent-1", first!.id);
    await service.finishAttempt("agent-1", secondAttempt.id, {
      status: "FAILED",
      error: "Provider failed",
    });

    await expect(service.get(second!.id)).resolves.toMatchObject({
      status: "IN_PROGRESS",
      phase: "QUEUED",
    });
    await expect(
      prisma.worktreeRunLease.findMany({ select: { runId: true } }),
    ).resolves.toEqual([{ runId: second!.id }]);
  });

  test("preserves queued successors while orphan reaping releases an active slot", async () => {
    const first = await service.create(input("SESSION", "Orphaned owner"));
    const second = await service.create(input("SESSION", "Queued successor"));
    const now = Date.now();
    await prisma.agent.update({
      where: { id: "agent-1" },
      data: { lastSeenAt: new Date(now - 60 * 60_000) },
    });

    await expect(service.reapOrphanedRuns(now)).resolves.toBe(1);

    await expect(service.get(first!.id)).resolves.toMatchObject({
      status: "FAILED",
      phase: "AGENT_OFFLINE",
    });
    await expect(service.get(second!.id)).resolves.toMatchObject({
      status: "IN_PROGRESS",
      phase: "QUEUED",
    });
    await expect(
      prisma.worktreeRunLease.findMany({ select: { runId: true } }),
    ).resolves.toEqual([{ runId: second!.id }]);
  });

  test("terminalizes queued cancellation without starting the run", async () => {
    await service.create(input("SESSION", "Slot owner"));
    const queued = await service.create(input("SESSION", "Cancel me"));
    const command = await prisma.runCommand.findFirstOrThrow({
      where: { runId: queued!.id },
    });

    await service.lifecycle(queued!.id, "CANCEL");

    await expect(service.get(queued!.id)).resolves.toMatchObject({
      status: "CANCELLED",
      phase: "CANCELLED",
      startedAt: null,
    });
    await expect(
      prisma.runCommand.findUnique({ where: { id: command.id } }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
    await expect(
      prisma.worktreeRunLease.findUnique({ where: { runId: queued!.id } }),
    ).resolves.toBeNull();
  });

  test("rejects worktree concurrency limits outside the public range", async () => {
    for (const limit of [-1, 1.5, 33]) {
      await expect(
        service.create(input("SESSION", `Invalid ${limit}`, limit)),
      ).rejects.toThrow("Worktree concurrency limit must be between 0 and 32");
    }
    await expect(prisma.agentRun.count()).resolves.toBe(0);
  });

  test("gives an exclusive workflow the whole worktree while admitting its own runs", async () => {
    const definition = emptyWorkflowDefinition("Exclusive workflow");
    await prisma.workflow.create({
      data: {
        id: "workflow-exclusive",
        name: definition.name,
        description: definition.description,
        draftDefinitionJson: JSON.stringify(definition),
        exclusiveWorktree: true,
      },
    });
    await prisma.workflowVersion.create({
      data: {
        id: "workflow-version-exclusive",
        workflowId: "workflow-exclusive",
        version: 1,
        name: definition.name,
        description: definition.description,
        schemaVersion: definition.schemaVersion,
        definitionJson: JSON.stringify(definition),
        contentHash: "exclusive-workflow-definition",
      },
    });
    await prisma.workflow.update({
      where: { id: "workflow-exclusive" },
      data: {
        activeVersionId: "workflow-version-exclusive",
        enabled: true,
      },
    });

    const blocker = await service.create(input("SESSION", "Earlier work"));
    const exclusiveRun = await prisma.workflowRun.create({
      data: {
        id: "workflow-run-exclusive",
        displayNumber: 0,
        workflowId: "workflow-exclusive",
        versionId: "workflow-version-exclusive",
        idempotencyKey: "workflow-run-exclusive",
        triggerKind: "MANUAL",
        triggerSubjectKey: "manual",
        triggerPayloadJson: "{}",
        sessionDataJson: JSON.stringify({
          workflow: { id: "workflow-exclusive" },
          worktree: { id: "worktree-1" },
        }),
        worktreeId: "worktree-1",
        worktreeLeaseOwnerRunId: "workflow-run-exclusive",
        exclusiveWorktree: true,
        phase: "WAITING_FOR_WORKTREE",
      },
    });
    const workflows = new WorkflowsService(
      new WorkflowEventsService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const workflowInternals = workflows as unknown as {
      startQueuedRuns(): Promise<void>;
    };

    await workflowInternals.startQueuedRuns();
    await expect(
      prisma.workflowRun.findUnique({ where: { id: exclusiveRun.id } }),
    ).resolves.toMatchObject({
      status: "QUEUED",
      phase: "WAITING_FOR_WORKTREE",
    });
    const laterPlan = await service.create(
      input("PLAN", "Created behind exclusive barrier"),
    );
    expect(laterPlan).toMatchObject({
      status: "QUEUED",
      phase: "WAITING_FOR_WORKTREE",
    });

    const blockerAttempt = await service.beginAttempt("agent-1", blocker!.id);
    await service.finishAttempt("agent-1", blockerAttempt.id, {
      status: "COMPLETED",
      finalOutput: "Done",
    });
    await expect(
      prisma.worktreeWorkflowLease.findUnique({
        where: { worktreeId: "worktree-1" },
      }),
    ).resolves.toMatchObject({ workflowRunId: exclusiveRun.id });

    await prisma.workflow.create({
      data: {
        id: "workflow-regular",
        name: "Regular workflow",
        draftDefinitionJson: JSON.stringify(definition),
      },
    });
    await prisma.workflowVersion.create({
      data: {
        id: "workflow-version-regular",
        workflowId: "workflow-regular",
        version: 1,
        name: "Regular workflow",
        schemaVersion: definition.schemaVersion,
        definitionJson: JSON.stringify(definition),
        contentHash: "regular-workflow-definition",
      },
    });
    const regularWorkflowRun = await prisma.workflowRun.create({
      data: {
        id: "workflow-run-regular",
        displayNumber: 1,
        workflowId: "workflow-regular",
        versionId: "workflow-version-regular",
        idempotencyKey: "workflow-run-regular",
        triggerKind: "MANUAL",
        triggerSubjectKey: "manual",
        triggerPayloadJson: "{}",
        sessionDataJson: JSON.stringify({
          workflow: { id: "workflow-regular" },
          worktree: { id: "worktree-1" },
        }),
        worktreeId: "worktree-1",
      },
    });
    await workflowInternals.startQueuedRuns();
    await expect(
      prisma.workflowRun.findUnique({ where: { id: regularWorkflowRun.id } }),
    ).resolves.toMatchObject({
      status: "QUEUED",
      phase: "WAITING_FOR_WORKTREE",
    });

    const owned = await service.create({
      ...input("PLAN", "Owned workflow plan", 1),
      workflowRunId: exclusiveRun.id,
    });
    const ownedQueued = await service.create({
      ...input("PLAN", "Second owned workflow plan", 1),
      workflowRunId: exclusiveRun.id,
    });
    const unrelated = await service.create(input("PLAN", "Unrelated plan"));
    expect(owned?.status).toBe("IN_PROGRESS");
    expect(ownedQueued).toMatchObject({
      status: "QUEUED",
      phase: "WAITING_FOR_WORKTREE",
    });
    expect(unrelated).toMatchObject({
      status: "QUEUED",
      phase: "WAITING_FOR_WORKTREE",
    });

    await expect(
      workflows.runQueue({ worktreeId: "worktree-1" }),
    ).resolves.toMatchObject([
      { id: ownedQueued!.id, kind: "PLAN", position: 1 },
      { id: laterPlan!.id, kind: "PLAN", position: 2 },
      { id: regularWorkflowRun.id, kind: "WORKFLOW", position: 3 },
      { id: unrelated!.id, kind: "PLAN", position: 4 },
    ]);
    await expect(
      workflows.runQueue({ workflowId: "workflow-exclusive" }),
    ).resolves.toMatchObject([
      { id: ownedQueued!.id, kind: "PLAN", position: 1 },
    ]);
    await expect(
      workflows.runQueue({ workflowId: "workflow-regular" }),
    ).resolves.toMatchObject([
      { id: regularWorkflowRun.id, kind: "WORKFLOW", position: 3 },
    ]);

    const ownedAttempt = await service.beginAttempt("agent-1", owned!.id);
    await service.finishAttempt("agent-1", ownedAttempt.id, {
      status: "COMPLETED",
      finalOutput: "Done",
    });
    const ownedQueuedAttempt = await service.beginAttempt(
      "agent-1",
      ownedQueued!.id,
    );
    await service.finishAttempt("agent-1", ownedQueuedAttempt.id, {
      status: "COMPLETED",
      finalOutput: "Done",
    });
    await workflows.lifecycle(exclusiveRun.id, "CANCEL");

    await expect(
      prisma.worktreeWorkflowLease.findUnique({
        where: { worktreeId: "worktree-1" },
      }),
    ).resolves.toBeNull();
    await expect(service.get(unrelated!.id)).resolves.toMatchObject({
      status: "IN_PROGRESS",
    });
    await expect(service.get(laterPlan!.id)).resolves.toMatchObject({
      status: "IN_PROGRESS",
    });
    await expect(
      prisma.workflowRun.findUnique({ where: { id: regularWorkflowRun.id } }),
    ).resolves.toMatchObject({ status: "RUNNING" });
  });
});
