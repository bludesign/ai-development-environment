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
import { WORKTREE_POST_MERGE_SWITCH_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";
import { PrismaClient } from "@/generated/prisma/client";
import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import { WorktreesService } from "./worktrees.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

let prisma: PrismaClient;
let directory: string;
let template: string;
let count = 0;
const older = new Date(1_000);
const observed = new Date(2_000);
const newer = new Date(3_000);
const payload = {
  codebaseId: "codebase",
  folder: "/repo",
  gitDirectory: "/repo/.git",
  expectedOrigin: "github.com/acme/repo",
  expectedBranch: "feature/reviewed",
  expectedHeadSha: "a".repeat(40),
  branch: "main",
  mergeCommitSha: "b".repeat(40),
};
const item = {
  gitDirectory: payload.gitDirectory,
  folder: payload.folder,
  relativePath: ".",
  primary: true,
  branch: "main",
  headSha: payload.mergeCommitSha,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  syncState: "IN_SYNC",
  baseAhead: 0,
  baseBehind: 0,
  availability: "AVAILABLE",
  error: null,
  checkedAt: observed.toISOString(),
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-switch-projection-"));
  template = join(directory, "template.db");
  const database = new Database(":memory:");
  try {
    for (const migration of readdirSync("prisma/migrations").sort()) {
      const path = join("prisma/migrations", migration, "migration.sql");
      if (existsSync(path)) database.exec(readFileSync(path, "utf8"));
    }
    await database.backup(template);
  } finally {
    database.close();
  }
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  const path = join(directory, `test-${++count}.db`);
  await copyFile(template, path);
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  getPrismaClient.mockResolvedValue(prisma);
  await prisma.agent.create({
    data: {
      id: "agent",
      name: "agent",
      hostname: "test",
      version: "1",
      osVersion: "macOS",
      architecture: "arm64",
      capabilitiesJson: "[]",
      secretHash: "test",
    },
  });
  await prisma.codebaseRepository.create({
    data: {
      id: "repository",
      name: "repo",
      canonicalOrigin: payload.expectedOrigin,
      displayOrigin: payload.expectedOrigin,
    },
  });
  await prisma.codebase.create({
    data: {
      id: payload.codebaseId,
      agentId: "agent",
      repositoryId: "repository",
      folder: payload.folder,
      observedOrigin: payload.expectedOrigin,
      defaultBranch: "main",
      branch: payload.expectedBranch,
      headSha: payload.expectedHeadSha,
      upstream: "origin/feature/reviewed",
      ahead: 1,
      behind: 2,
      syncState: "DIVERGED",
      localBranchesJson: '["feature/reviewed"]',
      lastCheckedAt: older,
    },
  });
  await prisma.worktree.create({
    data: {
      id: "primary",
      codebaseId: payload.codebaseId,
      gitDirectory: payload.gitDirectory,
      folder: payload.folder,
      relativePath: ".",
      primary: true,
      branch: payload.expectedBranch,
      headSha: payload.expectedHeadSha,
      baseBranchOverride: "release",
      lastCheckedAt: older,
    },
  });
});
afterEach(async () => {
  await prisma.$disconnect();
});

function complete(status = "SUCCEEDED") {
  const registerCompletionHandler = vi.fn();
  const service = new WorktreesService(
    { registerCompletionHandler } as unknown as AgentControlService,
    {} as JiraService,
    {} as GitHubService,
  );
  vi.spyOn(
    service as unknown as {
      publish(worktreeId: string | null, codebaseId: string | null): void;
    },
    "publish",
  ).mockImplementation(() => {});
  const handler = registerCompletionHandler.mock.calls.find(
    ([kind]) => kind === WORKTREE_POST_MERGE_SWITCH_JOB_KIND,
  )![1] as (job: unknown) => Promise<void>;
  return handler({
    agentId: "agent",
    codebaseId: payload.codebaseId,
    worktreeId: "primary",
    payloadJson: JSON.stringify(payload),
    resultJson: JSON.stringify({ outcome: "SWITCHED", worktree: item }),
    status,
  });
}

test("projects the primary worktree and codebase immediately and adds the new local branch", async () => {
  await complete();
  expect(
    await prisma.worktree.findUniqueOrThrow({ where: { id: "primary" } }),
  ).toMatchObject({
    branch: "main",
    headSha: payload.mergeCommitSha,
    baseBranchOverride: "release",
    lastCheckedAt: observed,
  });
  expect(
    await prisma.codebase.findUniqueOrThrow({
      where: { id: payload.codebaseId },
    }),
  ).toMatchObject({
    branch: "main",
    headSha: payload.mergeCommitSha,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    syncState: "IN_SYNC",
    localBranchesJson: '["feature/reviewed","main"]',
    lastCheckedAt: observed,
  });
});

test.each([
  "lastCheckedAt",
  "worktreeInventoryObservedAt",
  "localBranchInventoryAttemptedAt",
])("does not overwrite a newer codebase %s", async (field) => {
  await prisma.codebase.update({
    where: { id: payload.codebaseId },
    data: {
      [field]: newer,
      branch: "newer-branch",
      headSha: "newer-head",
      localBranchesJson: '["newer-branch"]',
    },
  });
  await complete();
  expect(
    await prisma.codebase.findUniqueOrThrow({
      where: { id: payload.codebaseId },
    }),
  ).toMatchObject({
    branch: "newer-branch",
    headSha: "newer-head",
    localBranchesJson: '["newer-branch"]',
  });
});

test("does not use an old job to overwrite a newer worktree observation", async () => {
  await prisma.worktree.update({
    where: { id: "primary" },
    data: {
      branch: "newer-branch",
      headSha: "newer-head",
      lastCheckedAt: newer,
    },
  });
  await complete();
  expect(
    await prisma.worktree.findUniqueOrThrow({ where: { id: "primary" } }),
  ).toMatchObject({ branch: "newer-branch", headSha: "newer-head" });
  expect(
    await prisma.codebase.findUniqueOrThrow({
      where: { id: payload.codebaseId },
    }),
  ).toMatchObject({
    branch: payload.expectedBranch,
    localBranchesJson: '["feature/reviewed"]',
  });
});

test.each([
  "worktree-folder",
  "git-directory",
  "codebase-folder",
  "origin",
  "primary",
  "missing",
])("ignores completion after %s identity changes", async (change) => {
  if (change === "codebase-folder")
    await prisma.codebase.update({
      where: { id: payload.codebaseId },
      data: { folder: "/moved" },
    });
  else if (change === "origin")
    await prisma.codebaseRepository.update({
      where: { id: "repository" },
      data: { canonicalOrigin: "github.com/another/repo" },
    });
  else
    await prisma.worktree.update({
      where: { id: "primary" },
      data:
        change === "worktree-folder"
          ? { folder: "/moved" }
          : change === "git-directory"
            ? { gitDirectory: "/moved/.git" }
            : change === "primary"
              ? { primary: false }
              : { missingAt: new Date() },
    });
  await complete();
  expect(
    await prisma.worktree.findUniqueOrThrow({ where: { id: "primary" } }),
  ).toMatchObject({
    branch: payload.expectedBranch,
    headSha: payload.expectedHeadSha,
  });
  expect(
    await prisma.codebase.findUniqueOrThrow({
      where: { id: payload.codebaseId },
    }),
  ).toMatchObject({
    branch: payload.expectedBranch,
    localBranchesJson: '["feature/reviewed"]',
  });
});

test("does not project a failed job", async () => {
  await complete("FAILED");
  expect(
    await prisma.codebase.findUniqueOrThrow({
      where: { id: payload.codebaseId },
    }),
  ).toMatchObject({ branch: payload.expectedBranch, lastCheckedAt: older });
});
