import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { expect, test, vi } from "vitest";
import type { CcusageService } from "@/services/ccusage";
import type { DiskSpaceService } from "@/services/disk-space";
import type { PollingService } from "@/services/polling";
const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
import { SystemStatusService } from "./system-status.service";

test("Live Activity counts include active work and exclude attention-only rows across every local category", async () => {
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
  });
  try {
    for (const sql of [
      `CREATE TABLE AgentRun (id TEXT PRIMARY KEY, kind TEXT, status TEXT, phase TEXT NOT NULL DEFAULT 'QUEUED', archivedAt DATETIME)`,
      `CREATE TABLE RunQuestionBatch (id TEXT PRIMARY KEY, runId TEXT, workflowStepAttemptId TEXT, status TEXT)`,
      `CREATE TABLE Build (id TEXT PRIMARY KEY, status TEXT)`,
      `CREATE TABLE WorkflowRun (id TEXT PRIMARY KEY, status TEXT, archivedAt DATETIME)`,
      `CREATE TABLE WorkflowStepAttempt (id TEXT PRIMARY KEY, runId TEXT, supersededAt DATETIME)`,
      `CREATE TABLE CommandRun (id TEXT PRIMARY KEY, status TEXT, archivedAt DATETIME)`,
      `INSERT INTO AgentRun (id,kind,status) VALUES ('plan-queued','PLAN','QUEUED'),('plan-question','PLAN','IN_PROGRESS'),('plan-paused','PLAN','PAUSED'),('plan-failed','PLAN','FAILED'),('session-running','SESSION','IN_PROGRESS'),('session-queued','SESSION','QUEUED')`,
      `INSERT INTO AgentRun (id,kind,status,phase) VALUES ('plan-blocked','PLAN','IN_PROGRESS','PREPARATION_FAILED'),('plan-collision','PLAN','IN_PROGRESS','IMPORTED_ACTIVE_COLLISION')`,
      `INSERT INTO AgentRun (id,kind,status,archivedAt) VALUES ('archived-session','SESSION','IN_PROGRESS',CURRENT_TIMESTAMP)`,
      `INSERT INTO RunQuestionBatch (id,runId,status) VALUES ('agent-question','plan-question','PENDING')`,
      `INSERT INTO Build (id,status) VALUES ('queued','QUEUED'),('preparing','PREPARING'),('running','RUNNING'),('unrun','SUCCEEDED'),('failed','FAILED')`,
      `INSERT INTO WorkflowRun (id,status) VALUES ('queued','QUEUED'),('running','RUNNING'),('pausing','PAUSING'),('question','RUNNING'),('old-question','RUNNING'),('waiting','WAITING'),('paused','PAUSED'),('blocked','BLOCKED'),('failed','FAILED')`,
      `INSERT INTO WorkflowStepAttempt (id,runId,supersededAt) VALUES ('current-attempt','question',NULL),('old-attempt','old-question',CURRENT_TIMESTAMP)`,
      `INSERT INTO RunQuestionBatch (id,workflowStepAttemptId,status) VALUES ('workflow-question','current-attempt','PENDING'),('superseded-question','old-attempt','PENDING')`,
      `INSERT INTO CommandRun (id,status) VALUES ('queued','QUEUED'),('running','RUNNING'),('restarting','RESTARTING'),('cancelling','CANCELLING'),('finished','SUCCEEDED'),('failed','FAILED')`,
    ])
      await prisma.$executeRawUnsafe(sql);
    const now = new Date();
    const period = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    getPrismaClient.mockResolvedValue({
      agentRun: {
        count: vi.fn().mockResolvedValue(0),
        groupBy: prisma.agentRun.groupBy.bind(prisma.agentRun),
      },
      build: prisma.build,
      workflowRun: prisma.workflowRun,
      commandRun: prisma.commandRun,
      actionCenterSettings: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ showWorktreeCountsInSidebar: false }),
      },
      sidebarUsageSummary: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ period, totalCost: 0, collectedAt: now }),
      },
    });
    const service = new SystemStatusService(
      { registerCompletionObserver: vi.fn() } as unknown as CcusageService,
      {} as DiskSpaceService,
      {} as PollingService,
    );
    const status = await service.status(false, { includeUnfinishedWork: true });
    expect(status.unfinishedWork).toMatchObject({
      plans: 1,
      sessions: 2,
      builds: 3,
      workflows: 4,
      commands: 4,
    });
  } finally {
    await prisma.$disconnect();
  }
});
