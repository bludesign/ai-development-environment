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
  expect,
  test,
  vi,
} from "vitest";
const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));
import { PrismaClient } from "@/generated/prisma/client";
import { randomReviewerPreview, ReviewersService } from "./service";
import type { ReviewerDiscovery, ReviewerPerson } from "./types";

const person = (id: string): ReviewerPerson => ({
  id,
  username: id,
  name: id,
  avatarUrl: null,
  url: null,
});
const identity = "GITHUB:github.com:42";
const key = `${identity}:general`;
let directory: string,
  template: string,
  counter = 0,
  prisma: PrismaClient,
  service: ReviewersService,
  discovery: ReviewerDiscovery;
const discover = vi.fn();
const assign = vi.fn();
const refresh = vi.fn();

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-reviewers-"));
  template = join(directory, "template.db");
  const db = new Database(template);
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    for (const dir of readdirSync(resolve("prisma/migrations")).sort()) {
      const file = resolve("prisma/migrations", dir, "migration.sql");
      if (existsSync(file)) db.exec(readFileSync(file, "utf8"));
    }
  })();
  db.close();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  const path = join(directory, `test-${counter++}.db`);
  await copyFile(template, path);
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  mocks.getPrismaClient.mockResolvedValue(prisma);
  discovery = {
    provider: "GITHUB",
    repositoryIdentity: identity,
    ref: "main",
    defaultRef: "main",
    refs: ["main", "release"],
    pools: [
      {
        key,
        name: "General reviewers",
        kind: "GENERAL",
        candidates: [
          person("author"),
          person("alice"),
          person("bob"),
          person("carol"),
        ],
      },
    ],
    requirements: [
      {
        id: "approval",
        name: "Two approvals",
        poolKeys: [key],
        eligibleReviewerIds: ["author", "alice", "bob", "carol"],
        requiredApprovals: 2,
        approvedReviewerIds: [],
      },
    ],
    issues: [],
    discoveryComplete: true,
    request: {
      id: "pull-1",
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
      open: true,
      authorId: "author",
      baseRef: "main",
      headSha: "abc",
      currentReviewers: [],
      approvedReviewers: [],
    },
  };
  discover.mockImplementation(async () => structuredClone(discovery));
  assign.mockImplementation(
    async (_repository, _locator, people: ReviewerPerson[]) => {
      discovery.request!.currentReviewers.push(...people);
    },
  );
  refresh.mockResolvedValue(undefined);
  service = new ReviewersService({ discover, assign }, refresh);
  await prisma.codebaseRepository.create({
    data: {
      id: "repo",
      canonicalOrigin: "github.com/acme/repo",
      displayOrigin: "github.com/acme/repo",
      name: "Repo",
    },
  });
});
afterEach(async () => {
  await prisma.$disconnect();
  vi.clearAllMocks();
});

async function save(ids = ["alice", "bob", "carol", "author"]) {
  return service.saveRepositoryCodeReviewers({
    repositoryId: "repo",
    pools: [{ key, reviewerIds: ids }],
  });
}
async function worktree() {
  await prisma.agent.create({
    data: {
      id: "agent",
      name: "Mac",
      hostname: "mac",
      version: "1",
      osVersion: "1",
      architecture: "arm64",
      capabilitiesJson: "[]",
      secretHash: "secret",
    },
  });
  await prisma.codebase.create({
    data: {
      id: "codebase",
      repositoryId: "repo",
      agentId: "agent",
      folder: "/repo",
      observedOrigin: "github.com/acme/repo",
    },
  });
  await prisma.worktree.create({
    data: {
      id: "worktree",
      codebaseId: "codebase",
      gitDirectory: "/repo/.git",
      folder: "/repo/feature",
      relativePath: "feature",
      branch: "feature",
      pullRequestLookupOrigin: "github.com/acme/repo",
      pullRequestLookupBranch: "feature",
    },
  });
  await prisma.worktreePullRequest.create({
    data: {
      worktreeId: "worktree",
      githubId: "pull-1",
      number: 1,
      title: "Change",
      url: "https://github.com/acme/repo/pull/1",
      repositoryGithubId: "42",
      repositoryNameWithOwner: "acme/repo",
      repositoryUrl: "https://github.com/acme/repo",
      labelsJson: "[]",
      reviewDecision: "REVIEW_REQUIRED",
      unresolvedReviewThreadCount: 0,
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      autoMergeEnabled: false,
      viewerCanEnableAutoMerge: false,
      viewerCanDisableAutoMerge: false,
      headRefOid: "abc",
      headRefName: "feature",
      githubCreatedAt: new Date(),
    },
  });
}

test("migration starts unconfigured and saving/clearing pools updates availability", async () => {
  expect(
    (
      await prisma.codebaseRepository.findUniqueOrThrow({
        where: { id: "repo" },
      })
    ).hasConfiguredCodeReviewers,
  ).toBe(false);
  await save();
  expect(
    (
      await prisma.codebaseRepository.findUniqueOrThrow({
        where: { id: "repo" },
      })
    ).hasConfiguredCodeReviewers,
  ).toBe(true);
  await save([]);
  expect(
    (
      await prisma.codebaseRepository.findUniqueOrThrow({
        where: { id: "repo" },
      })
    ).hasConfiguredCodeReviewers,
  ).toBe(false);
  expect(await prisma.repositoryReviewerMember.count()).toBe(0);
});

test("discovery preserves preferences and marks unavailable members without selecting new members", async () => {
  await save(["alice", "bob"]);
  discovery.pools[0].candidates = [person("alice"), person("carol")];
  const result = await service.repositoryCodeReviewers("repo");
  expect(result.pools[0].selectedReviewerIds).toEqual(["alice", "bob"]);
  expect(result.pools[0].unavailableReviewerIds).toEqual(["bob"]);
  await expect(save(["carol", "missing"])).rejects.toThrow("eligible");
  await save(["alice", "bob"]);
});

test("branch discovery and partial saves retain other configured groups", async () => {
  await save(["alice"]);
  discovery.pools = [
    {
      key: `${identity}:rule:2`,
      name: "Release",
      kind: "APPROVAL_RULE",
      candidates: [person("bob")],
    },
  ];
  await service.saveRepositoryCodeReviewers({
    repositoryId: "repo",
    ref: "release",
    pools: [{ key: `${identity}:rule:2`, reviewerIds: ["bob"] }],
  });
  expect(await prisma.repositoryReviewerPool.count()).toBe(2);
});

test("saving all pools on another branch preserves refs for unavailable groups through transfer", async () => {
  const releaseKey = `${identity}:owners:release`;
  const releaseDiscovery: ReviewerDiscovery = {
    ...discovery,
    ref: "release",
    pools: [
      ...discovery.pools,
      {
        key: releaseKey,
        name: "Release owners",
        kind: "CODEOWNERS",
        candidates: [person("bob")],
      },
    ],
  };
  discover.mockImplementation(async (_repository, ref) =>
    structuredClone(ref === "release" ? releaseDiscovery : discovery),
  );
  await service.saveRepositoryCodeReviewers({
    repositoryId: "repo",
    ref: "release",
    pools: [
      { key, reviewerIds: ["alice"] },
      { key: releaseKey, reviewerIds: ["bob"] },
    ],
  });

  const mainSettings = await service.repositoryCodeReviewers("repo", "main");
  expect(
    mainSettings.pools.find((pool) => pool.key === releaseKey),
  ).toMatchObject({
    candidates: [],
    selectedReviewerIds: ["bob"],
    unavailableReviewerIds: ["bob"],
  });
  await service.saveRepositoryCodeReviewers({
    repositoryId: "repo",
    ref: "main",
    pools: mainSettings.pools.map((pool) => ({
      key: pool.key,
      reviewerIds: pool.key === key ? ["carol"] : pool.selectedReviewerIds,
    })),
  });

  const exported = await service.exportPools("repo");
  expect(exported.find((pool) => pool.key === key)?.ref).toBe("main");
  expect(exported.find((pool) => pool.key === releaseKey)?.ref).toBe("release");
  const validated = await service.validateTransferredPools(
    { id: "repo", canonicalOrigin: "github.com/acme/repo" },
    exported,
  );
  await prisma.$transaction((tx) =>
    service.applyTransferredPools(tx, "repo", validated),
  );
  expect(await service.exportPools("repo")).toEqual(exported);
});

test("random fills two distinct slots, excludes the author and never sends requests", async () => {
  await save();
  await worktree();
  const options = await service.worktreeReviewerAssignment("worktree");
  expect(options.requirements[0].candidateReviewerIds).not.toContain("author");
  const preview = randomReviewerPreview(options, [], () => 0);
  expect(new Set(preview.selectedReviewerIds).size).toBe(2);
  expect(preview.selectedReviewerIds).not.toContain("author");
  expect(assign).not.toHaveBeenCalled();
});

test("existing approvals and pending requests count once even outside preferred pools", async () => {
  await save(["carol"]);
  await worktree();
  discovery.request!.currentReviewers = [person("alice"), person("bob")];
  discovery.request!.approvedReviewers = [person("alice")];
  discovery.requirements[0].approvedReviewerIds = ["alice"];
  const preview = await service.previewRandomWorktreeReviewers(
    "worktree",
    "pull-1",
  );
  expect(preview.selectedReviewerIds).toEqual([]);
  expect(preview.requirements[0].approvedReviewerIds).toEqual(["alice"]);
  expect(preview.requirements[0].requestedReviewerIds).toEqual([
    "alice",
    "bob",
  ]);
});

test("overlapping rules reuse a person and insufficient pools report shortages", async () => {
  await save(["alice"]);
  await worktree();
  discovery.requirements.push({
    ...discovery.requirements[0],
    id: "ownership",
    name: "Owners",
    requiredApprovals: 1,
  });
  const preview = await service.previewRandomWorktreeReviewers(
    "worktree",
    "pull-1",
  );
  expect(preview.selectedReviewerIds).toEqual(["alice"]);
  expect(preview.issues).toContainEqual(
    expect.stringContaining("Two approvals: 1 more"),
  );
  expect(preview.issues.some((issue) => issue.startsWith("Owners"))).toBe(
    false,
  );
});

test("manual partial assignment is additive and retry skips already requested people", async () => {
  await save();
  await worktree();
  discovery.request!.currentReviewers = [person("bob")];
  await service.assignWorktreeReviewers({
    worktreeId: "worktree",
    requestId: "pull-1",
    reviewerIds: ["alice"],
  });
  await service.assignWorktreeReviewers({
    worktreeId: "worktree",
    requestId: "pull-1",
    reviewerIds: ["alice"],
  });
  expect(assign).toHaveBeenCalledTimes(1);
  expect(discovery.request!.currentReviewers.map((p) => p.id)).toEqual([
    "bob",
    "alice",
  ]);
});

test("fresh identity, closed requests and removed eligibility reject writes", async () => {
  await save();
  await worktree();
  const input = {
    worktreeId: "worktree",
    requestId: "other",
    reviewerIds: ["alice"],
  };
  await expect(service.assignWorktreeReviewers(input)).rejects.toThrow(
    "changed",
  );
  discovery.requirements[0].eligibleReviewerIds = ["bob"];
  await expect(
    service.assignWorktreeReviewers({ ...input, requestId: "pull-1" }),
  ).rejects.toThrow("eligible");
  discovery.request!.open = false;
  await expect(
    service.assignWorktreeReviewers({ ...input, requestId: "pull-1" }),
  ).rejects.toThrow("no longer open");
  expect(assign).not.toHaveBeenCalled();
});

test("portable pools are revalidated and provider identity cannot cross hosts", async () => {
  await save(["alice"]);
  const exported = await service.exportPools("repo");
  const validated = await service.validateTransferredPools(
    { id: "repo", canonicalOrigin: "github.com/acme/repo" },
    exported,
  );
  await prisma.$transaction((tx) =>
    service.applyTransferredPools(tx, "repo", validated),
  );
  expect(
    (await service.repositoryCodeReviewers("repo")).pools[0]
      .selectedReviewerIds,
  ).toEqual(["alice"]);
  discovery.repositoryIdentity = "GITHUB:other.example:42";
  await expect(
    service.validateTransferredPools(
      { id: "repo", canonicalOrigin: "other.example/acme/repo" },
      exported,
    ),
  ).rejects.toThrow("different provider instance");
});

test("pool records cascade with their repository", async () => {
  await save();
  await prisma.codebaseRepository.delete({ where: { id: "repo" } });
  expect(await prisma.repositoryReviewerPool.count()).toBe(0);
  expect(await prisma.repositoryReviewerMember.count()).toBe(0);
});

test("moving between owner groups never transfers stale preferred membership", async () => {
  await save(["bob"]);
  await worktree();
  const otherKey = `${identity}:owners:other`;
  discovery.pools.push({
    key: otherKey,
    name: "Other owners",
    kind: "CODEOWNERS",
    candidates: [person("bob")],
  });
  discovery.pools[0].candidates = [person("alice")];
  discovery.requirements[0].poolKeys = [key, otherKey];
  const options = await service.worktreeReviewerAssignment("worktree");
  expect(options.requirements[0].eligibleReviewerIds).toContain("bob");
  expect(options.requirements[0].candidateReviewerIds).not.toContain("bob");
});

test("stale branch associations cannot assign to an old open request", async () => {
  await save();
  await worktree();
  await prisma.worktree.update({
    where: { id: "worktree" },
    data: {
      branch: "new-branch",
      pullRequestLookupBranch: null,
      pullRequestLookupOrigin: null,
    },
  });
  await expect(
    service.assignWorktreeReviewers({
      worktreeId: "worktree",
      requestId: "pull-1",
      reviewerIds: ["alice"],
    }),
  ).rejects.toThrow("branch or repository has changed");
  expect(assign).not.toHaveBeenCalled();
});

test("branch changes and reviewer revocations during provider discovery are checked again", async () => {
  await save();
  await worktree();
  discover.mockImplementationOnce(async () => {
    await prisma.repositoryReviewerMember.deleteMany({
      where: { userId: "alice" },
    });
    return structuredClone(discovery);
  });
  await expect(
    service.assignWorktreeReviewers({
      worktreeId: "worktree",
      requestId: "pull-1",
      reviewerIds: ["alice"],
    }),
  ).rejects.toThrow("no longer eligible");
  expect(assign).not.toHaveBeenCalled();
});
