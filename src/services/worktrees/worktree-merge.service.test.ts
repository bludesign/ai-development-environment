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
import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import type { GitLabMergeService } from "@/services/gitlab/gitlab-merge.service";
import { withMergeReservation } from "@/services/operation-locks/operation-locks.service";
import type { WorktreeAutomationService } from "./worktree-automation.service";

const mock = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => mock);
import { WorktreeMergeService } from "./worktree-merge.service";

const HEAD = "a".repeat(40);
const GITLAB = "https://gitlab.example.test";
const github = { pullRequestAutomationState: vi.fn() };
const gitlab = {
  getSettings: vi.fn(),
  mergeRequestState: vi.fn(),
  mergeProject: vi.fn(),
};
const githubMerges = {
  pullRequestMergeOptions: vi.fn(),
  mergePullRequest: vi.fn(),
  bulkMergeFollowUp: vi.fn(),
};
const gitlabMerges = {
  options: vi.fn(),
  submit: vi.fn(),
  bulkMergeFollowUp: vi.fn(),
};

let prisma: PrismaClient;
let directory: string;
let template: string;
let databaseCount = 0;

function service() {
  return new WorktreeMergeService(
    github as unknown as GitHubService,
    gitlab as unknown as GitLabService,
    githubMerges as unknown as WorktreeAutomationService,
    gitlabMerges as unknown as GitLabMergeService,
  );
}

function githubItem(worktreeId: string, number: number) {
  return {
    worktreeId,
    requestKey: JSON.stringify(["GITHUB", "team/repo", number]),
    reviewedHeadSha: HEAD,
    reviewedTargetBranch: "main",
    github: {
      owner: "team",
      name: "repo",
      number,
      method: "SQUASH" as const,
      commitHeadline: `Feature ${number}`,
      commitBody: "",
    },
  };
}

const gitlabItem = {
  worktreeId: "gitlab",
  requestKey: JSON.stringify(["GITLAB", GITLAB, "42", 7]),
  reviewedHeadSha: HEAD,
  reviewedTargetBranch: "main",
  gitlab: {
    projectId: "42",
    iid: 7,
    sha: HEAD,
    squash: true,
    mergeCommitMessage: "GitLab merge",
    moveTicketToDone: true,
  },
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-bulk-merge-"));
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
  vi.resetAllMocks();
  const path = join(directory, `test-${++databaseCount}.db`);
  await copyFile(template, path);
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  mock.getPrismaClient.mockResolvedValue(prisma);
  for (const [id, origin] of [
    ["github", "github.com/team/repo"],
    ["gitlab", "gitlab.example.test/team/repo"],
  ] as const) {
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
    await prisma.codebaseRepository.create({
      data: { id, name: id, canonicalOrigin: origin, displayOrigin: origin },
    });
    await prisma.codebase.create({
      data: {
        id,
        agentId: id,
        repositoryId: id,
        folder: `/repos/${id}`,
        observedOrigin: origin,
        defaultBranch: "main",
      },
    });
  }
  for (const [worktreeId, provider, number, branch] of [
    ["first", "github", 1, "feature/first"],
    ["second", "github", 2, "feature/second"],
    ["duplicate", "github", 1, "feature/first"],
    ["gitlab", "gitlab", 7, "feature/gitlab"],
  ] as const) {
    await prisma.worktree.create({
      data: {
        id: worktreeId,
        codebaseId: provider,
        folder: `/worktrees/${worktreeId}`,
        gitDirectory: `/git/${worktreeId}`,
        relativePath: worktreeId,
        branch,
        headSha: HEAD,
      },
    });
    if (provider === "github") {
      await prisma.worktreePullRequest.create({
        data: {
          worktreeId,
          githubId: `PR_${number}`,
          number,
          title: `Feature ${number}`,
          url: `https://github.com/team/repo/pull/${number}`,
          repositoryGithubId: "repo",
          repositoryNameWithOwner: "team/repo",
          repositoryUrl: "https://github.com/team/repo",
          labelsJson: "[]",
          reviewDecision: "APPROVED",
          unresolvedReviewThreadCount: 0,
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          autoMergeEnabled: false,
          viewerCanEnableAutoMerge: true,
          viewerCanDisableAutoMerge: true,
          headRefOid: HEAD,
          headRefName: branch,
          githubCreatedAt: new Date(),
        },
      });
    } else {
      await prisma.worktreeGitLabMergeRequest.create({
        data: {
          worktreeId,
          gitlabId: "MR_7",
          iid: number,
          projectId: "42",
          title: "GitLab feature",
          description: "",
          webUrl: `${GITLAB}/team/repo/-/merge_requests/7`,
          state: "OPENED",
          draft: false,
          sourceBranch: branch,
          targetBranch: "main",
          sha: HEAD,
          authorJson: "{}",
          reviewersJson: "[]",
          labelsJson: "[]",
          detailedMergeStatus: "mergeable",
          mergeWhenPipelineSucceeds: false,
          squashOnMerge: false,
          hasConflicts: false,
          blockingDiscussionsResolved: true,
          gitlabCreatedAt: new Date(),
          gitlabUpdatedAt: new Date(),
        },
      });
    }
  }
  githubMerges.pullRequestMergeOptions.mockImplementation(
    async (_owner, _name, _number, _source, worktreeId) => ({
      canMerge: true,
      headRefOid: HEAD,
      baseRefName: "main",
      worktreeId,
    }),
  );
  githubMerges.mergePullRequest.mockResolvedValue({
    state: "MERGED",
    postMergeError: null,
  });
  githubMerges.bulkMergeFollowUp.mockResolvedValue(null);
  gitlab.getSettings.mockResolvedValue({ configured: true, baseUrl: GITLAB });
  gitlab.mergeProject.mockResolvedValue({ web_url: `${GITLAB}/team/repo` });
  gitlabMerges.options.mockImplementation(
    async (_projectId, _iid, worktreeId) => ({
      canMerge: true,
      sha: HEAD,
      targetBranch: "main",
      worktreeId,
    }),
  );
  gitlabMerges.submit.mockResolvedValue({
    mergeRequest: {
      state: "MERGED",
      sha: HEAD,
      sourceBranch: "feature/gitlab",
      targetBranch: "main",
      sourceProjectId: "42",
    },
    postMergeError: "Jira follow-up could not be scheduled",
  });
  gitlabMerges.bulkMergeFollowUp.mockResolvedValue(null);
});

test("checks scope and persists one ordered, idempotent set of settings", async () => {
  const merge = service();
  await expect(
    merge.start({
      requestId: "duplicate",
      items: [githubItem("first", 1), githubItem("duplicate", 1)],
    }),
  ).rejects.toThrow("one worktree per");
  await expect(
    merge.start({
      requestId: "scope",
      agentId: "gitlab",
      items: [githubItem("first", 1)],
    }),
  ).rejects.toThrow("scope");
  const input = {
    requestId: "ordered",
    items: [githubItem("first", 1), gitlabItem],
  };
  const batch = await merge.start(input);
  expect((await service().start(input)).id).toBe(batch.id);
  await expect(
    merge.start({ ...input, items: [...input.items].reverse() }),
  ).rejects.toThrow("different Bulk Merge");
  await merge.reconcile();
  expect(
    githubMerges.mergePullRequest.mock.invocationCallOrder[0],
  ).toBeLessThan(gitlabMerges.submit.mock.invocationCallOrder[0]!);
  expect(githubMerges.mergePullRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "SQUASH",
      commitHeadline: "Feature 1",
      worktreeId: "first",
    }),
    "WORKTREE_AUTOMATION",
    expect.objectContaining({
      itemId: batch.items[0]?.id,
      headSha: HEAD,
      targetBranch: "main",
    }),
  );
  expect(gitlabMerges.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      squash: true,
      mergeCommitMessage: "GitLab merge",
      moveTicketToDone: true,
      autoMerge: false,
      autoSync: false,
    }),
    expect.objectContaining({
      instanceUrl: GITLAB,
      headSha: HEAD,
      targetBranch: "main",
    }),
  );
  await prisma.worktree.delete({ where: { id: "first" } });
  expect(await merge.batch(batch.id)).toMatchObject({
    status: "COMPLETED",
    items: [
      { status: "MERGED", worktreeId: "first", requestTitle: "Feature 1" },
      {
        status: "MERGED",
        postMergeError: "Jira follow-up could not be scheduled",
      },
    ],
  });
});

test("skips a stale reviewed row and still merges the next request targeting main", async () => {
  const merge = service();
  const batch = await merge.start({
    requestId: "stale",
    items: [githubItem("first", 1), githubItem("second", 2)],
  });
  githubMerges.pullRequestMergeOptions.mockResolvedValueOnce({
    canMerge: true,
    headRefOid: HEAD,
    baseRefName: "release",
    worktreeId: "first",
  });
  await merge.reconcile();
  expect(githubMerges.mergePullRequest).toHaveBeenCalledTimes(1);
  expect(githubMerges.mergePullRequest).toHaveBeenCalledWith(
    expect.objectContaining({ number: 2 }),
    "WORKTREE_AUTOMATION",
    expect.anything(),
  );
  expect(await merge.batch(batch.id)).toMatchObject({
    status: "COMPLETED",
    items: [
      {
        status: "SKIPPED",
        error: expect.stringContaining("target branch changed"),
      },
      { status: "MERGED" },
    ],
  });
});

test("recovers a lost provider response after restart without replaying and reports late follow-up warnings", async () => {
  const merge = service();
  const batch = await merge.start({
    requestId: "lost-response",
    items: [githubItem("first", 1), githubItem("second", 2)],
  });
  githubMerges.mergePullRequest.mockImplementationOnce(() =>
    withMergeReservation(
      "github.com/team/repo",
      "feature/first",
      async (reservation) => {
        await reservation.markSubmitted();
        throw Object.assign(new Error("Response lost"), {
          mergeOutcomeUnknown: true,
        });
      },
      { provider: "GITHUB", owner: "Team", name: "Repo", number: 1 },
    ),
  );
  const remote = {
    headRefOid: HEAD,
    headRefName: "feature/first",
    headRepositoryNameWithOwner: "team/repo",
    baseRefName: "main",
  };
  github.pullRequestAutomationState.mockResolvedValueOnce({
    ...remote,
    state: "OPEN",
  });
  await merge.reconcile();
  expect(await merge.batch(batch.id)).toMatchObject({
    status: "ACTIVE",
    items: [{ status: "SUBMITTING" }, { status: "PENDING" }],
  });
  const reservation = await prisma.operationHolder.findFirstOrThrow({
    where: { ownerKind: "MERGE_SUBMISSION", state: "HELD" },
  });
  github.pullRequestAutomationState.mockResolvedValueOnce({
    ...remote,
    state: "MERGED",
  });
  githubMerges.bulkMergeFollowUp.mockResolvedValueOnce({
    state: "POST_MERGE",
    lastError: null,
  });
  const restarted = service();
  await restarted.reconcile();
  await expect(
    prisma.operationHolder.findUnique({ where: { id: reservation.id } }),
  ).resolves.toMatchObject({ state: "RELEASED" });
  expect(await restarted.batch(batch.id)).toMatchObject({
    status: "ACTIVE",
    items: [
      { status: "MERGED", finishedAt: null },
      { status: "MERGED", finishedAt: expect.any(String) },
    ],
  });
  expect(
    githubMerges.mergePullRequest.mock.calls.map(([input]) => input.number),
  ).toEqual([1, 2]);
  githubMerges.bulkMergeFollowUp.mockResolvedValueOnce({
    state: "ACTION_REQUIRED",
    lastError: "Could not switch checkout",
  });
  await restarted.reconcile();
  expect(await restarted.batch(batch.id)).toMatchObject({
    status: "COMPLETED",
    items: [
      { status: "MERGED", postMergeError: "Could not switch checkout" },
      { status: "MERGED" },
    ],
  });
});

test.each([
  { status: "SUBMITTING", iid: 7 },
  { status: "SUBMITTING", iid: 8 },
  { status: "MERGED", iid: 7 },
])(
  "releases a GitLab reservation for a $status row only when the request matches (IID $iid)",
  async ({ status, iid }) => {
    const merge = service();
    const batch = await merge.start({
      requestId: "gitlab-lost-response",
      items: [gitlabItem],
    });
    const unknown = Object.assign(new Error("Response lost"), {
      mergeOutcomeUnknown: true,
    });
    await expect(
      withMergeReservation(
        "gitlab.example.test/team/repo",
        "feature/gitlab",
        async (reservation) => {
          await reservation.markSubmitted();
          throw unknown;
        },
        { provider: "GITLAB", projectId: "42", iid },
      ),
    ).rejects.toBe(unknown);
    await prisma.worktreeMergeItem.update({
      where: { id: batch.items[0]!.id },
      data: { status, startedAt: new Date() },
    });
    gitlab.mergeRequestState.mockResolvedValueOnce({
      state: "MERGED",
      sha: HEAD,
      sourceBranch: "feature/gitlab",
      targetBranch: "main",
      sourceProjectId: "42",
    });
    const reservation = await prisma.operationHolder.findFirstOrThrow({
      where: { ownerKind: "MERGE_SUBMISSION", state: "HELD" },
    });
    await merge.reconcile();
    expect(gitlabMerges.submit).not.toHaveBeenCalled();
    expect(await merge.batch(batch.id)).toMatchObject({
      status: "COMPLETED",
      items: [{ status: "MERGED" }],
    });
    await expect(
      prisma.operationHolder.findUnique({ where: { id: reservation.id } }),
    ).resolves.toMatchObject({ state: iid === 7 ? "RELEASED" : "HELD" });
  },
);

test("does not retry an unconfirmed submission once its observation window expires", async () => {
  const merge = service();
  const batch = await merge.start({
    requestId: "unknown",
    items: [githubItem("first", 1)],
  });
  await prisma.worktreeMergeItem.update({
    where: { id: batch.items[0]!.id },
    data: { status: "SUBMITTING", startedAt: new Date(Date.now() - 121_000) },
  });
  github.pullRequestAutomationState.mockResolvedValue({ state: "OPEN" });
  await merge.reconcile();
  expect(githubMerges.mergePullRequest).not.toHaveBeenCalled();
  expect(await merge.batch(batch.id)).toMatchObject({
    status: "COMPLETED",
    items: [
      {
        status: "ATTENTION_REQUIRED",
        error: expect.stringContaining("could not be confirmed"),
      },
    ],
  });
});

test("reserves one pending row per request across concurrent scopes", async () => {
  const merge = service();
  const results = await Promise.all([
    merge.start({ requestId: "global", items: [githubItem("first", 1)] }),
    service().start({
      requestId: "focused",
      agentId: "github",
      items: [githubItem("duplicate", 1)],
    }),
  ]);
  expect(results.map((batch) => batch.items[0]?.status).sort()).toEqual([
    "PENDING",
    "SKIPPED",
  ]);
  expect(
    (await merge.candidates({ agentId: "github" }))
      .filter(({ requestNumber }) => requestNumber === 1)
      .map(({ blockedReason }) => blockedReason),
  ).toEqual([
    "A Bulk Merge submission already owns this request.",
    "A Bulk Merge submission already owns this request.",
  ]);
  await merge.reconcile();
  expect(githubMerges.mergePullRequest).toHaveBeenCalledTimes(1);
});

test("skips a duplicate already queued while an earlier submission was uncertain", async () => {
  const merge = service();
  const earlier = await merge.start({
    requestId: "earlier",
    items: [githubItem("first", 1)],
  });
  const later = await merge.start({
    requestId: "later",
    items: [githubItem("duplicate", 1)],
  });
  const now = Date.now();
  await prisma.worktreeMergeBatch.update({
    where: { id: earlier.id },
    data: { createdAt: new Date(now - 200_000) },
  });
  await prisma.worktreeMergeItem.update({
    where: { id: earlier.items[0]!.id },
    data: { status: "SUBMITTING", startedAt: new Date(now - 130_000) },
  });
  await prisma.worktreeMergeBatch.update({
    where: { id: later.id },
    data: {
      status: "ACTIVE",
      createdAt: new Date(now - 100_000),
      finishedAt: null,
    },
  });
  await prisma.worktreeMergeItem.update({
    where: { id: later.items[0]!.id },
    data: { status: "PENDING", finishedAt: null, error: null },
  });
  github.pullRequestAutomationState.mockResolvedValue({ state: "OPEN" });
  await merge.reconcile();
  expect(githubMerges.mergePullRequest).not.toHaveBeenCalled();
  expect((await merge.batch(earlier.id))?.items[0]?.status).toBe(
    "ATTENTION_REQUIRED",
  );
  expect((await merge.batch(later.id))?.items[0]?.status).toBe("SKIPPED");
});
