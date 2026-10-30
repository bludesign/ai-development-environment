// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import type { WorktreesService } from "./worktrees.service";
const mock = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => mock);
import {
  baseBranchUpdateResults,
  completeBaseBranchUpdates,
  mergeBaseBranchUpdateOptions,
  prepareBaseBranchUpdates,
} from "./merge-base-branch-updates";

let prisma: PrismaClient;
let directory: string;
const refreshed = vi.fn();
const worktrees = {
  refreshBaseBranchWatch: refreshed,
} as unknown as WorktreesService;
const confirmed = { origin: "github.com/acme/repo", branch: "parent" };
async function source() {
  return prisma.worktree.findUniqueOrThrow({
    where: { id: "parent" },
    include: { codebase: { include: { repository: true } } },
  });
}
async function save(ids = ["child"]) {
  const baseBranchUpdatesJson = await prepareBaseBranchUpdates("parent", {
    worktreeIds: ids,
    destinationBaseBranch: "main",
  });
  await prisma.worktreeAutoMerge.create({
    data: {
      worktreeId: "parent",
      repositoryNameWithOwner: "acme/repo",
      pullRequestNumber: 1,
      branch: "parent",
      mergeMethod: "SQUASH",
      commitHeadline: "Merge",
      baseBranchUpdatesJson,
    },
  });
}
beforeEach(async () => {
  refreshed.mockReset();
  directory = await mkdtemp(join(tmpdir(), "aide-merge-bases-"));
  const path = join(directory, "test.db");
  const db = new Database(path);
  for (const migration of readdirSync("prisma/migrations").sort()) {
    const path = join("prisma/migrations", migration, "migration.sql");
    if (existsSync(path)) db.exec(readFileSync(path, "utf8"));
  }
  db.close();
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  mock.getPrismaClient.mockResolvedValue(prisma);
  for (const id of ["one", "two"]) {
    await prisma.agent.create({
      data: {
        id,
        name: id,
        hostname: id,
        version: "1",
        osVersion: "macOS",
        architecture: "arm64",
        capabilitiesJson: "[]",
        secretHash: id,
      },
    });
  }
  for (const id of ["repo", "unrelated"])
    await prisma.codebaseRepository.create({
      data: {
        id,
        name: id,
        canonicalOrigin: `github.com/acme/${id}`,
        displayOrigin: id,
      },
    });
  for (const [id, agentId, repositoryId, defaultBranch] of [
    ["one", "one", "repo", "main"],
    ["two", "two", "repo", "parent"],
    ["other", "one", "unrelated", "parent"],
  ]) {
    await prisma.codebase.create({
      data: {
        id,
        agentId,
        repositoryId,
        folder: `/repos/${id}`,
        observedOrigin: repositoryId,
        remoteBranchesJson: JSON.stringify(["main", "parent", "release"]),
        defaultBranch,
      },
    });
  }
  for (const [id, codebaseId, branch, baseBranchOverride] of [
    ["parent", "one", "parent", null],
    ["child", "one", "child", "parent"],
    ["remote", "two", "remote", null],
    ["other", "other", "other", null],
    ["self", "one", "main", "parent"],
  ]) {
    await prisma.worktree.create({
      data: {
        id: id!,
        codebaseId: codebaseId!,
        branch,
        baseBranchOverride,
        folder: `/work/${id}`,
        gitDirectory: `/git/${id}`,
        relativePath: id!,
      },
    });
  }
});
afterEach(async () => {
  await prisma.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

test("discovers explicit and inherited targets across agents, with no initial selections", async () => {
  const options = await mergeBaseBranchUpdateOptions(await source());
  expect(options).toMatchObject({
    destinationBaseBranch: "main",
    selectedWorktreeIds: [],
    results: [],
  });
  expect(
    options?.worktrees.map((target) => [
      target.id,
      target.agentName,
      target.canUpdate,
    ]),
  ).toEqual([
    ["child", "one", true],
    ["remote", "two", true],
    ["self", "one", false],
  ]);
});
test("rejects stale destinations and selections outside the offered repository", async () => {
  await expect(
    prepareBaseBranchUpdates("parent", {
      worktreeIds: ["child"],
      destinationBaseBranch: "old",
    }),
  ).rejects.toThrow("destination base branch changed");
  for (const id of ["other", "self", "parent", "missing"])
    await expect(
      prepareBaseBranchUpdates("parent", {
        worktreeIds: [id],
        destinationBaseBranch: "main",
      }),
    ).rejects.toThrow("selected worktree");
  expect(await prepareBaseBranchUpdates(null)).toBeNull();
  expect(
    await prepareBaseBranchUpdates(null, {
      worktreeIds: [],
      destinationBaseBranch: "main",
    }),
  ).toBeNull();
});
test("disables candidates if the source has no destination and excludes missing targets", async () => {
  await prisma.codebase.update({
    where: { id: "one" },
    data: { defaultBranch: null },
  });
  await prisma.worktree.update({
    where: { id: "child" },
    data: { missingAt: new Date() },
  });
  const options = await mergeBaseBranchUpdateOptions(await source());
  expect(options?.destinationBaseBranch).toBeNull();
  expect(options?.worktrees.every((target) => !target.canUpdate)).toBe(true);
  expect(options?.worktrees.some((target) => target.id === "child")).toBe(
    false,
  );
});
test.each(["GITHUB", "GITLAB"] as const)(
  "%s updates only selected targets, freezes destination, and survives retries",
  async (provider) => {
    await save(["child", "remote"]);
    const plan = (
      await prisma.worktreeAutoMerge.findUniqueOrThrow({
        where: { worktreeId: "parent" },
      })
    ).baseBranchUpdatesJson;
    if (provider === "GITLAB")
      await prisma.gitLabMergeOperation.create({
        data: {
          id: "merge",
          instanceUrl: "https://gitlab.test",
          projectId: "1",
          iid: 1,
          branch: "parent",
          sha: "abc",
          baseBranchUpdatesJson: plan,
        },
      });
    const record = { provider, id: provider === "GITHUB" ? "parent" : "merge" };
    await prisma.worktree.update({
      where: { id: "parent" },
      data: { baseBranchOverride: "develop" },
    });
    const reopened = await mergeBaseBranchUpdateOptions(await source(), plan);
    expect(reopened?.destinationBaseBranch).toBe("main");
    expect(reopened?.selectedWorktreeIds.sort()).toEqual(["child", "remote"]);
    await completeBaseBranchUpdates(record, confirmed, worktrees);
    for (const id of ["child", "remote"])
      expect(
        (await prisma.worktree.findUniqueOrThrow({ where: { id } }))
          .baseBranchOverride,
      ).toBe("main");
    expect(refreshed).toHaveBeenCalledTimes(2);
    await prisma.worktree.update({
      where: { id: "child" },
      data: { baseBranchOverride: "later-edit" },
    });
    await completeBaseBranchUpdates(record, confirmed, worktrees);
    expect(
      (await prisma.worktree.findUniqueOrThrow({ where: { id: "child" } }))
        .baseBranchOverride,
    ).toBe("later-edit");
    expect(refreshed).toHaveBeenCalledTimes(2);
  },
);
test.each(["branch", "base", "repository", "deleted", "missing", "already"])(
  "records a safe outcome when target is %s",
  async (change) => {
    await save();
    if (change === "deleted")
      await prisma.worktree.delete({ where: { id: "child" } });
    else
      await prisma.worktree.update({
        where: { id: "child" },
        data:
          change === "branch"
            ? { branch: "renamed" }
            : change === "repository"
              ? { codebaseId: "other" }
              : change === "missing"
                ? { missingAt: new Date() }
                : {
                    baseBranchOverride:
                      change === "already" ? "main" : "different",
                  },
      });
    await completeBaseBranchUpdates(
      { provider: "GITHUB", id: "parent" },
      confirmed,
      worktrees,
    );
    const row = await prisma.worktreeAutoMerge.findUniqueOrThrow({
      where: { worktreeId: "parent" },
    });
    expect(baseBranchUpdateResults(row.baseBranchUpdatesJson)[0]?.status).toBe(
      change === "already" ? "ALREADY_UPDATED" : "SKIPPED",
    );
    expect(refreshed).not.toHaveBeenCalled();
  },
);
test("rejects mismatched merged sources without touching bases or completion markers", async () => {
  await save();
  for (const invalid of [
    { ...confirmed, branch: "wrong" },
    { ...confirmed, origin: "github.com/fork/repo" },
  ])
    await expect(
      completeBaseBranchUpdates(
        { provider: "GITHUB", id: "parent" },
        invalid,
        worktrees,
      ),
    ).rejects.toThrow("merged source");
  expect(
    (await prisma.worktree.findUniqueOrThrow({ where: { id: "child" } }))
      .baseBranchOverride,
  ).toBe("parent");
  const row = await prisma.worktreeAutoMerge.findUniqueOrThrow({
    where: { worktreeId: "parent" },
  });
  expect(baseBranchUpdateResults(row.baseBranchUpdatesJson)).toEqual([]);
});

test("GitHub waits for merge confirmation and updates bases before parent cleanup", async () => {
  const { WorktreeAutomationService } =
    await import("./worktree-automation.service");
  await save();
  await prisma.worktree.update({
    where: { id: "parent" },
    data: { headSha: "sha" },
  });
  await prisma.worktreeAutoMerge.update({
    where: { worktreeId: "parent" },
    data: { deleteWorktree: true },
  });
  let state = "OPEN";
  const github = {
    pullRequestAutomationState: vi.fn(async () => ({
      state,
      autoMergeEnabled: true,
      headRefName: "parent",
      headRefOid: "sha",
      headRepositoryNameWithOwner: "acme/repo",
    })),
  };
  const deleteWorktree = vi.fn(async () => {
    expect(
      (await prisma.worktree.findUniqueOrThrow({ where: { id: "child" } }))
        .baseBranchOverride,
    ).toBe("main");
    return { id: "delete" };
  });
  const service = new WorktreeAutomationService(
    {
      ...worktrees,
      deleteWorktree,
      publishAutomationChange: vi.fn(),
    } as unknown as WorktreesService,
    github as unknown as import("@/services/github").GitHubService,
    {} as import("@/services/jira").JiraService,
    {} as import("@/services/workflows").WorkflowsService,
    {
      registerCompletionObserver: vi.fn(),
    } as unknown as import("@/services/agent-control").AgentControlService,
  );
  const internal = service as unknown as {
    reconcileAutoMergeRules: () => Promise<void>;
  };
  await internal.reconcileAutoMergeRules();
  expect(
    (await prisma.worktree.findUniqueOrThrow({ where: { id: "child" } }))
      .baseBranchOverride,
  ).toBe("parent");
  state = "MERGED";
  await internal.reconcileAutoMergeRules();
  await internal.reconcileAutoMergeRules();
  expect(deleteWorktree).toHaveBeenCalledOnce();
});

test("GitHub closed requests never apply saved base updates", async () => {
  const { WorktreeAutomationService } =
    await import("./worktree-automation.service");
  await save();
  const service = new WorktreeAutomationService(
    {
      ...worktrees,
      publishAutomationChange: vi.fn(),
    } as unknown as WorktreesService,
    {
      pullRequestAutomationState: async () => ({ state: "CLOSED" }),
    } as unknown as import("@/services/github").GitHubService,
    {} as import("@/services/jira").JiraService,
    {} as import("@/services/workflows").WorkflowsService,
    {
      registerCompletionObserver: vi.fn(),
    } as unknown as import("@/services/agent-control").AgentControlService,
  );
  await (
    service as unknown as { reconcileAutoMergeRules: () => Promise<void> }
  ).reconcileAutoMergeRules();
  expect(
    (await prisma.worktree.findUniqueOrThrow({ where: { id: "child" } }))
      .baseBranchOverride,
  ).toBe("parent");
  expect(
    (
      await prisma.worktreeAutoMerge.findUniqueOrThrow({
        where: { worktreeId: "parent" },
      })
    ).state,
  ).toBe("ACTION_REQUIRED");
});

test("GitLab saves updated outcomes before completing merge follow-ups", async () => {
  const { GitLabMergeService } =
    await import("@/services/gitlab/gitlab-merge.service");
  await save();
  const saved = await prisma.worktreeAutoMerge.findUniqueOrThrow({
    where: { worktreeId: "parent" },
  });
  const row = await prisma.gitLabMergeOperation.create({
    data: {
      id: "merge",
      instanceUrl: "https://gitlab.test",
      projectId: "1",
      iid: 1,
      branch: "parent",
      sha: "abc",
      baseBranchUpdatesJson: saved.baseBranchUpdatesJson,
      state: "POST_MERGE",
      mergeConfirmedAt: new Date(),
    },
  });
  const service = new GitLabMergeService(
    {
      setMergeCoordinator: vi.fn(),
      mergeRequestState: async () => ({
        state: "MERGED",
        sha: "abc",
        sourceBranch: "parent",
        sourceProjectId: null,
      }),
    } as unknown as import("@/services/gitlab/gitlab.service").GitLabService,
    worktrees,
    {} as import("@/services/jira").JiraService,
    {} as import("@/services/agent-control").AgentControlService,
  );
  const internal = service as unknown as {
    context: () => Promise<unknown>;
    changed: () => void;
    followUps: (value: typeof row) => Promise<void>;
  };
  vi.spyOn(internal, "context").mockResolvedValue({
    sourceOrigin: confirmed.origin,
  });
  vi.spyOn(internal, "changed").mockImplementation(() => {});
  await internal.followUps(row);
  const completed = await prisma.gitLabMergeOperation.findUniqueOrThrow({
    where: { id: row.id },
  });
  expect(completed.state).toBe("COMPLETED");
  expect(
    baseBranchUpdateResults(completed.baseBranchUpdatesJson)[0]?.status,
  ).toBe("UPDATED");
  expect(
    (await prisma.worktree.findUniqueOrThrow({ where: { id: "child" } }))
      .baseBranchOverride,
  ).toBe("main");
});

test("a failed completion-marker write rolls back bases and can be retried", async () => {
  await save();
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER fail_merge_updates BEFORE UPDATE OF baseBranchUpdatesJson ON WorktreeAutoMerge BEGIN SELECT RAISE(ABORT, 'write failed'); END`,
  );
  await expect(
    completeBaseBranchUpdates(
      { provider: "GITHUB", id: "parent" },
      confirmed,
      worktrees,
    ),
  ).rejects.toThrow();
  expect(
    (await prisma.worktree.findUniqueOrThrow({ where: { id: "child" } }))
      .baseBranchOverride,
  ).toBe("parent");
  expect(refreshed).not.toHaveBeenCalled();
  await prisma.$executeRawUnsafe("DROP TRIGGER fail_merge_updates");
  await completeBaseBranchUpdates(
    { provider: "GITHUB", id: "parent" },
    confirmed,
    worktrees,
  );
  expect(
    (await prisma.worktree.findUniqueOrThrow({ where: { id: "child" } }))
      .baseBranchOverride,
  ).toBe("main");
});

test("editing restores only still-eligible selections and disables unavailable origin destinations", async () => {
  await save(["child", "remote"]);
  const row = await prisma.worktreeAutoMerge.findUniqueOrThrow({
    where: { worktreeId: "parent" },
  });
  await prisma.worktree.update({
    where: { id: "child" },
    data: { branch: "different-child" },
  });
  expect(
    (
      await mergeBaseBranchUpdateOptions(
        await source(),
        row.baseBranchUpdatesJson,
      )
    )?.selectedWorktreeIds,
  ).toEqual(["remote"]);
  await prisma.codebase.update({
    where: { id: "one" },
    data: { remoteBranchesJson: "[]" },
  });
  const options = await mergeBaseBranchUpdateOptions(
    await source(),
    row.baseBranchUpdatesJson,
  );
  expect(options?.selectedWorktreeIds).toEqual([]);
  expect(options?.worktrees.every((target) => !target.canUpdate)).toBe(true);
  await expect(
    prepareBaseBranchUpdates("parent", {
      worktreeIds: ["remote"],
      destinationBaseBranch: "main",
    }),
  ).rejects.toThrow("selected worktree");
});
