import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import type { AgentControlService } from "@/services/agent-control";
import type { JiraService } from "@/services/jira";
import type { WorktreesService } from "@/services/worktrees";
import { GitLabMergeService } from "./gitlab-merge.service";
import type { GitLabService } from "./gitlab.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

let prisma: PrismaClient;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-gitlab-merge-recovery-"));
  const path = join(directory, "test.db");
  const database = new Database(path);
  try {
    for (const migration of readdirSync("prisma/migrations").sort()) {
      const migrationPath = join(
        "prisma/migrations",
        migration,
        "migration.sql",
      );
      if (existsSync(migrationPath))
        database.exec(readFileSync(migrationPath, "utf8"));
    }
  } finally {
    database.close();
  }
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  getPrismaClient.mockResolvedValue(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

function setup(configured = true) {
  const getSettings = vi.fn().mockResolvedValue({
    configured,
    baseUrl: configured ? "https://gitlab.test" : null,
  });
  const service = new GitLabMergeService(
    { setMergeCoordinator: vi.fn(), getSettings } as unknown as GitLabService,
    {} as WorktreesService,
    {} as JiraService,
    {
      registerCompletionObserver: vi.fn(),
      registerConnectionHandler: vi.fn(),
    } as unknown as AgentControlService,
  );
  return { service, getSettings };
}

test("skips settings and database lookups when no checkout is selected", async () => {
  const { service, getSettings } = setup();
  getPrismaClient.mockClear();
  expect(await service.worktreeMergeOperations([])).toEqual([]);
  expect(getSettings).not.toHaveBeenCalled();
  expect(getPrismaClient).not.toHaveBeenCalled();
});

test("does not recover operations for an unconfigured GitLab connection", async () => {
  const { service } = setup(false);
  getPrismaClient.mockClear();
  expect(await service.worktreeMergeOperations(["primary"])).toEqual([]);
  expect(getPrismaClient).not.toHaveBeenCalled();
});

test("recovers only unresolved switch plans for selected checkouts on the current instance", async () => {
  const pending = JSON.stringify({
    branch: "main",
    state: "PENDING",
    lastError: null,
  });
  const completed = JSON.stringify({
    branch: "main",
    state: "COMPLETED",
    lastError: null,
  });
  const base = {
    instanceUrl: "https://gitlab.test",
    projectId: "7",
    branch: "feature/merged",
    sha: "reviewed-sha",
    worktreeId: "primary",
    state: "POST_MERGE",
    postMergeSwitchJson: pending,
  };
  await prisma.gitLabMergeOperation.createMany({
    data: [
      { ...base, id: "pending", iid: 1 },
      {
        ...base,
        id: "jira-failed",
        iid: 2,
        state: "ACTION_REQUIRED",
        postMergeSwitchJson: completed,
        lastError: "Jira unavailable",
      },
      { ...base, id: "other-checkout", iid: 3, worktreeId: "other" },
      {
        ...base,
        id: "old-instance",
        iid: 4,
        instanceUrl: "https://old-gitlab.test",
      },
      { ...base, id: "without-switch", iid: 5, postMergeSwitchJson: null },
      ...["COMPLETED", "CANCELED", "CANCELLED"].map((state, index) => ({
        ...base,
        id: state,
        iid: 6 + index,
        state,
      })),
    ],
  });
  const { service } = setup();
  const operations = await service.worktreeMergeOperations([
    "primary",
    "primary",
  ]);
  expect(operations.map(({ id }) => id).sort()).toEqual([
    "jira-failed",
    "pending",
  ]);
  expect(operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "pending",
        projectId: "7",
        iid: 1,
        worktreeId: "primary",
        postMergeSwitch: { branch: "main", state: "PENDING", lastError: null },
      }),
      expect.objectContaining({
        id: "jira-failed",
        projectId: "7",
        iid: 2,
        state: "ACTION_REQUIRED",
        lastError: "Jira unavailable",
        postMergeSwitch: {
          branch: "main",
          state: "COMPLETED",
          lastError: null,
        },
      }),
    ]),
  );
});
