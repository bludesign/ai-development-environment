// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
import { GitHubActionsInventory } from "./github-actions-inventory";

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
  vi.useRealTimers();
});

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
