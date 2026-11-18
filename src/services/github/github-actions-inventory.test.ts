// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
import { GitHubActionsInventory } from "./github-actions-inventory";
import { GitHubPipelineStatusService } from "./github-pipeline-status.service";
import type { GitHubPipelineState } from "./types";

let prisma: PrismaClient;
let inventory: GitHubActionsInventory;
const run = (
  status = "queued",
  attempt = 1,
  time = "2026-10-29T12:00:00Z",
) => ({
  id: "101",
  workflowId: "20",
  runAttempt: attempt,
  status,
  updatedAt: new Date(time),
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T12:05:00Z"));
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
  });
  await prisma.$executeRawUnsafe(
    `CREATE TABLE GitHubWorkflowRunObservation (id TEXT PRIMARY KEY, codebaseRepositoryId TEXT NOT NULL, workflowRunId TEXT NOT NULL, runAttempt INTEGER NOT NULL, workflowId TEXT NOT NULL, status TEXT NOT NULL, conclusion TEXT, githubUpdatedAt DATETIME NOT NULL, source TEXT NOT NULL, notifiedAt DATETIME, firstObservedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, lastObservedAt DATETIME NOT NULL, UNIQUE(codebaseRepositoryId,workflowRunId,runAttempt))`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE GitHubActionsPollingState (codebaseRepositoryId TEXT PRIMARY KEY, initializedAt DATETIME NOT NULL, lastPollStartedAt DATETIME, lastPollCompletedAt DATETIME, lastPollSucceededAt DATETIME, lastError TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`,
  );
  await prisma.$executeRawUnsafe(`CREATE TABLE GitHubPipelineSnapshot (
    id TEXT PRIMARY KEY, sourceControlProvider TEXT NOT NULL DEFAULT 'GITHUB',
    repositoryGithubId TEXT NOT NULL, repositoryNameWithOwner TEXT NOT NULL,
    repositoryUrl TEXT NOT NULL, headSha TEXT NOT NULL, pipelineStatus TEXT NOT NULL,
    graphqlRollupStatus TEXT, revision INTEGER NOT NULL DEFAULT 0,
    lastGraphqlSyncAt DATETIME, lastObservedAt DATETIME NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL,
    UNIQUE(repositoryGithubId, headSha)
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE GitHubPipelineRecord (
    id TEXT PRIMARY KEY, sourceControlProvider TEXT NOT NULL DEFAULT 'GITHUB',
    snapshotId TEXT NOT NULL, identityKey TEXT NOT NULL, githubPipelineId TEXT NOT NULL,
    name TEXT NOT NULL, status TEXT NOT NULL, url TEXT, checkSuiteId TEXT,
    workflowRunId TEXT, workflowId TEXT, runNumber INTEGER, runAttempt INTEGER,
    canRetry BOOLEAN NOT NULL DEFAULT false, retryUnavailableReason TEXT,
    jobsJson TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, githubUpdatedAt DATETIME,
    sourceFetchedAt DATETIME NOT NULL, lastObservedAt DATETIME NOT NULL,
    optimisticUntil DATETIME, isCurrent BOOLEAN NOT NULL DEFAULT true,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL,
    UNIQUE(snapshotId, identityKey)
  )`);
  const sql = await readFile(
    "prisma/migrations/20261029190000_track_github_active_workflow_runs/migration.sql",
    "utf8",
  );
  for (const statement of sql
    .split(";")
    .filter((statement) => statement.trim()))
    await prisma.$executeRawUnsafe(statement);
  getPrismaClient.mockResolvedValue(prisma);
  inventory = new GitHubActionsInventory();
});
afterEach(async () => {
  await prisma.$disconnect();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function observePipeline(
  status: GitHubPipelineState = "FAILURE",
  attempt: number | null = 1,
  time = "2026-10-29T12:01:00Z",
  completed = true,
) {
  await new GitHubPipelineStatusService().observeSnapshot({
    repositoryGithubId: "repository-1",
    repositoryNameWithOwner: "acme/widgets",
    repositoryUrl: "https://github.com/acme/widgets",
    headSha: "head-1",
    pipelines: [
      {
        id: "101",
        name: "CI",
        workflowRunId: "101",
        runAttempt: attempt,
        status,
        source: "WEBHOOK",
        canRetry: completed,
        retryUnavailableReason: completed ? null : "NOT_COMPLETED",
        githubUpdatedAt: new Date(time),
      },
    ],
  });
}

test("partial recent observations do not establish count completeness or notification history", async () => {
  await inventory.observe("repo", [run()], "REST");
  expect(await inventory.count(["repo"], "credential")).toBeNull();
  const observation = await prisma.gitHubWorkflowRunObservation.findFirst();
  expect(observation?.notificationObservedAt).toBeNull();
  await inventory.reconcile("repo", "credential", [run()], new Date());
  expect(await inventory.count(["repo"], "credential")).toBe(1);
  expect(await inventory.count(["repo"], "other-credential")).toBeNull();
});

test("deduplicates events, rejects older statuses and counts only the latest run attempt", async () => {
  await inventory.reconcile("repo", "credential", [run()], new Date());
  await inventory.observe("repo", [run(), run()], "WEBHOOK");
  expect(await inventory.count(["repo"], "credential")).toBe(1);
  await inventory.observe("repo", [run("completed")], "WEBHOOK");
  await inventory.observe("repo", [run("queued")], "WEBHOOK");
  expect(await inventory.count(["repo"], "credential")).toBe(0);
  await inventory.observe("repo", [run("queued", 2)], "WEBHOOK");
  await inventory.observe(
    "repo",
    [run("completed", 1, "2026-10-29T12:10:00Z")],
    "WEBHOOK",
  );
  expect(await inventory.count(["repo"], "credential")).toBe(1);
  await inventory.observe("repo", [run("completed", 2)], "WEBHOOK");
  expect(await inventory.count(["repo"], "credential")).toBe(0);
});

test("missed completions reconcile away, and cached active observations cannot restore them", async () => {
  const fetchedAt = new Date();
  await inventory.reconcile("repo", "credential", [run()], fetchedAt);
  vi.setSystemTime(new Date(Date.now() + 1_000));
  await inventory.reconcile("repo", "credential", [], new Date());
  await inventory.observe(
    "repo",
    [{ ...run(), observedAt: fetchedAt }],
    "REST",
  );
  expect(await inventory.count(["repo"], "credential")).toBe(0);
  vi.setSystemTime(new Date(Date.now() + 1_000));
  await inventory.reconcile("repo", "credential", [run()], new Date());
  expect(await inventory.count(["repo"], "credential")).toBe(1);
});

test.each(["queued", "unseen", "rerun"])(
  "reconciliation fences cached progress for a %s run",
  async (previous) => {
    await inventory.reconcile(
      "repo",
      "credential",
      previous === "unseen" ? [] : [run()],
      new Date(),
    );
    vi.setSystemTime(new Date(Date.now() + 1_000));
    const cached = {
      ...run(
        "in_progress",
        previous === "rerun" ? 2 : 1,
        new Date().toISOString(),
      ),
      observedAt: new Date(),
    };
    vi.setSystemTime(new Date(Date.now() + 1_000));
    await inventory.reconcile("repo", "credential", [], new Date());
    await inventory.observe("repo", [cached], "REST");
    expect(await inventory.count(["repo"], "credential")).toBe(0);

    vi.setSystemTime(new Date(Date.now() + 1_000));
    await inventory.observe(
      "repo",
      [{ ...cached, observedAt: new Date() }],
      "REST",
    );
    expect(await inventory.count(["repo"], "credential")).toBe(1);
  },
);

test("a webhook received during reconciliation wins over an older empty scan", async () => {
  await inventory.reconcile("repo", "credential", [], new Date());
  const startedAt = new Date();
  vi.setSystemTime(new Date(Date.now() + 1_000));
  await inventory.observe("repo", [run()], "WEBHOOK");
  await inventory.reconcile("repo", "credential", [], startedAt);
  expect(await inventory.count(["repo"], "credential")).toBe(1);
  const restarted = new GitHubActionsInventory();
  expect(await restarted.count(["repo"], "credential")).toBe(1);
});

test("failed reconciliation leaves the previous complete inventory intact", async () => {
  await inventory.reconcile("repo", "credential", [run()], new Date());
  await expect(
    inventory.reconcile(
      "repo",
      "credential",
      [
        run("completed"),
        { ...run(), id: "invalid", updatedAt: new Date("invalid") },
      ],
      new Date(),
    ),
  ).rejects.toThrow("Invalid workflow");
  expect(await inventory.count(["repo"], "credential")).toBe(1);
});

test.each([
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "neutral",
  "skipped",
  "stale",
  "action_required",
  "startup_failure",
])(
  "a terminal %s conclusion wins over a raw in-progress status",
  async (conclusion) => {
    await inventory.reconcile("repo", "credential", [run()], new Date());
    await inventory.observe(
      "repo",
      [{ ...run("in_progress"), conclusion }],
      "WEBHOOK",
    );
    expect(await inventory.count(["repo"], "credential")).toBe(0);
    expect(await prisma.gitHubWorkflowRunObservation.findFirst()).toMatchObject(
      {
        activeStatus: "completed",
        countedActive: false,
      },
    );
    // A duplicate page or job event cannot restore this same finished revision.
    vi.setSystemTime(new Date(Date.now() + 1_000));
    await inventory.observe("repo", [run("queued")], "REST");
    expect(await inventory.count(["repo"], "credential")).toBe(0);
    await inventory.observe("repo", [run("queued", 2)], "WEBHOOK");
    expect(await inventory.count(["repo"], "credential")).toBe(1);
  },
);

test("unknown provider statuses are not counted as unfinished work", async () => {
  await inventory.reconcile(
    "repo",
    "credential",
    [run("unrecognized")],
    new Date(),
  );
  expect(await inventory.count(["repo"], "credential")).toBe(0);
});

test("upgrades repair persisted active membership contradicted by its own conclusion", async () => {
  await inventory.reconcile("repo", "credential", [run()], new Date());
  // Represents a row written by the previous status-only membership reducer.
  await prisma.gitHubWorkflowRunObservation.updateMany({
    data: { status: "in_progress", conclusion: "failure" },
  });
  expect(await new GitHubActionsInventory().count(["repo"], "credential")).toBe(
    0,
  );
  expect(await prisma.gitHubWorkflowRunObservation.findFirst()).toMatchObject({
    countedActive: false,
    activeStatus: "completed",
    status: "in_progress",
    conclusion: "failure",
    notificationObservedAt: null,
  });
});

test.each(["SUCCESS", "FAILURE", "CANCELLED", "ACTION_REQUIRED"] as const)(
  "a canonical %s observation repairs the active inventory immediately",
  async (status) => {
    await inventory.reconcile("repo", "credential", [run()], new Date());
    await observePipeline(status);
    expect(await inventory.count(["repo"], "credential")).toBe(0);
    expect(await prisma.gitHubWorkflowRunObservation.findFirst()).toMatchObject(
      {
        countedActive: false,
        activeStatus: "completed",
        status: "queued",
        conclusion: null,
      },
    );
    await inventory.observe("repo", [run("in_progress")], "REST");
    expect(await inventory.count(["repo"], "credential")).toBe(0);
  },
);

test("an older canonical completion cannot hide a newer in-progress revision", async () => {
  await inventory.reconcile(
    "repo",
    "credential",
    [run("in_progress", 1, "2026-10-29T12:02:00Z")],
    new Date(),
  );
  await observePipeline("SUCCESS", 1, "2026-10-29T12:01:00Z");
  expect(await inventory.count(["repo"], "credential")).toBe(1);
});

test.each([1, null])(
  "a completion for attempt %s cannot hide a new rerun",
  async (attempt) => {
    await inventory.reconcile(
      "repo",
      "credential",
      [run("in_progress", 2)],
      new Date(),
    );
    await observePipeline("FAILURE", attempt, "2026-10-29T12:04:00Z");
    expect(await inventory.count(["repo"], "credential")).toBe(1);
    await observePipeline("SUCCESS", 2, "2026-10-29T12:04:00Z");
    expect(await inventory.count(["repo"], "credential")).toBe(0);
  },
);

test("a finished newer attempt retires membership left behind by the older attempt", async () => {
  await inventory.reconcile(
    "repo",
    "credential",
    [run("in_progress", 1)],
    new Date(),
  );
  await observePipeline("FAILURE", 2);
  expect(await inventory.count(["repo"], "credential")).toBe(0);
});

test("unknown canonical status and optimistic outcomes do not finish an active run", async () => {
  await inventory.reconcile(
    "repo",
    "credential",
    [run("in_progress")],
    new Date(),
  );
  await observePipeline("NONE");
  expect(await inventory.count(["repo"], "credential")).toBe(1);
  await prisma.gitHubPipelineRecord.updateMany({
    data: { status: "SUCCESS", source: "MUTATION" },
  });
  expect(await inventory.count(["repo"], "credential")).toBe(1);
});

test.each(["FAILURE", "SUCCESS"] as const)(
  "a displayed %s excludes the run without claiming an unfinished parent completed",
  async (status) => {
    await inventory.reconcile(
      "repo",
      "credential",
      [run("in_progress")],
      new Date(),
    );
    await observePipeline(status, 1, "2026-10-29T12:01:00Z", false);
    expect(await inventory.count(["repo"], "credential")).toBe(0);
    expect(await prisma.gitHubWorkflowRunObservation.findFirst()).toMatchObject(
      {
        countedActive: true,
        activeStatus: "in_progress",
      },
    );
    await observePipeline("IN_PROGRESS", 1, "2026-10-29T12:02:00Z", false);
    expect(await inventory.count(["repo"], "credential")).toBe(1);
  },
);

test("terminal repair does not overwrite progress received while canonical records were read", async () => {
  await inventory.reconcile("repo", "credential", [run()], new Date());
  await observePipeline("FAILURE");
  let receivedProgress = false;
  getPrismaClient.mockResolvedValue(
    prisma.$extends({
      query: {
        gitHubPipelineRecord: {
          async findMany({ args, query }) {
            const records = await query(args);
            if (!receivedProgress) {
              receivedProgress = true;
              await inventory.observe(
                "repo",
                [run("in_progress", 1, "2026-10-29T12:02:00Z")],
                "WEBHOOK",
              );
            }
            return records;
          },
        },
      },
    }),
  );
  expect(await inventory.count(["repo"], "credential")).toBe(1);
  expect(await inventory.count(["repo"], "credential")).toBe(1);
});
