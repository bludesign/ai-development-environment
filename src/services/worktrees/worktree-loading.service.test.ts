import { beforeEach, expect, test, vi } from "vitest";
import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import type { JiraService } from "@/services/jira";
import { WorktreesService } from "./worktrees.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

const row = (id = "worktree-1", sha = "head-1") => ({
  id,
  codebaseId: "codebase-1",
  branch: "feature/APP-1",
  headSha: sha,
  folder: `/repo/${id}`,
  highlightColor: "blue",
  tags: [],
  builds: [],
  pullRequest: null,
  gitLabMergeRequest: null,
  pullRequestLookupOrigin: null,
  pullRequestLookupBranch: null,
  pullRequestLookupAt: null,
  codebase: {
    id: "codebase-1",
    defaultBranch: "main",
    jobs: [],
    agent: { id: "agent-1", name: "Mac", baseRepoDirectory: "/repo" },
    repository: {
      id: "repo-1",
      canonicalOrigin: "gitlab.example/acme/app",
      jiraBranchRegex: "([A-Z]+-\\d+)",
    },
  },
});
const gitlab = {
  projectForCanonicalOrigin: vi.fn(),
  storedPipelines: vi.fn(),
  pipelinesForCommit: vi.fn(),
  mergeRequestForBranch: vi.fn(),
  mergeRequestSummary: vi.fn(),
};
const jira = { storedSummaries: vi.fn(), summary: vi.fn() };
const github = {
  pullRequestsForBranches: vi.fn(),
  pullRequestLiveStatuses: vi.fn(),
  effectiveCacheTtlSeconds: vi.fn(),
};
const snapshot = { snapshots: vi.fn() };
const findMany = vi.fn();
function service() {
  return new WorktreesService(
    { registerCompletionHandler: vi.fn() } as unknown as AgentControlService,
    jira as unknown as JiraService,
    github as unknown as GitHubService,
    undefined,
    undefined,
    snapshot as never,
    gitlab as unknown as GitLabService,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  findMany.mockResolvedValue([row()]);
  getPrismaClient.mockResolvedValue({
    worktree: {
      findMany,
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    worktreeTag: { findMany: vi.fn().mockResolvedValue([]) },
    worktreeSettings: {
      upsert: vi.fn().mockResolvedValue({ editorVariant: "CODE" }),
    },
    codebaseSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    worktreeMove: { findMany: vi.fn().mockResolvedValue([]) },
    workflow: { findMany: vi.fn().mockResolvedValue([]) },
  });
  gitlab.projectForCanonicalOrigin.mockResolvedValue({ id: "42" });
  gitlab.storedPipelines.mockResolvedValue(
    new Map([["42\0head-1", [{ id: "12", status: "RUNNING" }]]]),
  );
  gitlab.pipelinesForCommit.mockResolvedValue([
    { id: "12", status: "SUCCESS" },
  ]);
  gitlab.mergeRequestForBranch.mockResolvedValue(null);
  jira.storedSummaries.mockResolvedValue(
    new Map([["APP-1", { summary: "Saved ticket", status: "In Progress" }]]),
  );
  jira.summary.mockResolvedValue({ summary: "Current ticket", status: "Done" });
  snapshot.snapshots.mockResolvedValue([]);
});

test("saved-only overview reads saved pipeline and Jira data without any external calls", async () => {
  const overview = await service().overview("app-1", undefined, true);
  const worktree = overview.agents[0]!.codebases[0]!.worktrees[0]!;
  expect(worktree.ticketTitle).toBe("Saved ticket");
  expect(worktree.gitLabPipelines).toEqual([
    expect.objectContaining({
      id: "12",
      status: "RUNNING",
      worktreeId: "worktree-1",
    }),
  ]);
  expect(overview.durationMs).toBeGreaterThanOrEqual(0);
  expect(jira.summary).not.toHaveBeenCalled();
  expect(gitlab.pipelinesForCommit).not.toHaveBeenCalled();
  expect(gitlab.mergeRequestForBranch).not.toHaveBeenCalled();
  expect(github.pullRequestLiveStatuses).not.toHaveBeenCalled();
  expect(github.pullRequestsForBranches).not.toHaveBeenCalled();
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        codebase: { repository: { apps: { some: { appId: "app-1" } } } },
      }),
    }),
  );
});

test("a blocked GitLab pipeline read does not block saved data or Jira enrichment", async () => {
  const gate = Promise.withResolvers<[]>();
  gitlab.pipelinesForCommit.mockReturnValue(gate.promise);
  const instance = service();
  const pending = instance.enrichment({
    appId: "app-1",
    kind: "GITLAB_PIPELINES",
  });
  await vi.waitFor(() =>
    expect(gitlab.pipelinesForCommit).toHaveBeenCalledOnce(),
  );
  const [overview, tickets] = await Promise.all([
    instance.overview("app-1", undefined, true),
    instance.enrichment({ appId: "app-1", kind: "JIRA" }),
  ]);
  expect(overview.agents).toHaveLength(1);
  expect(tickets.updates[0]?.worktree.ticketTitle).toBe("Current ticket");
  gate.resolve([]);
  await pending;
});

test("deduplicates project/commit reads and associates the result with each checkout", async () => {
  findMany.mockResolvedValue([row(), row("worktree-2")]);
  const result = await service().enrichment({
    kind: "GITLAB_PIPELINES",
    force: true,
  });
  expect(gitlab.projectForCanonicalOrigin).toHaveBeenCalledOnce();
  expect(gitlab.pipelinesForCommit).toHaveBeenCalledOnce();
  expect(gitlab.pipelinesForCommit).toHaveBeenCalledWith(
    "42",
    "head-1",
    expect.objectContaining({ force: true }),
  );
  expect(
    result.updates.map(
      ({ worktree }) => worktree.gitLabPipelines[0]?.worktreeId,
    ),
  ).toEqual(["worktree-1", "worktree-2"]);
});

test("bounds pipeline fan-out and preserves successful results when one commit fails", async () => {
  findMany.mockResolvedValue(
    Array.from({ length: 9 }, (_, i) => row(`worktree-${i}`, `head-${i}`)),
  );
  const gate = Promise.withResolvers<void>();
  let active = 0,
    maximum = 0;
  gitlab.pipelinesForCommit.mockImplementation(async (_project, sha) => {
    maximum = Math.max(maximum, ++active);
    await gate.promise;
    active--;
    if (sha === "head-0") throw new Error("GitLab unavailable");
    return [{ id: sha, status: "SUCCESS" }];
  });
  const pending = service().enrichment({ kind: "GITLAB_PIPELINES" });
  await vi.waitFor(() =>
    expect(gitlab.pipelinesForCommit).toHaveBeenCalledTimes(4),
  );
  gate.resolve();
  const result = await pending;
  expect(maximum).toBe(4);
  expect(result.updates).toHaveLength(8);
  expect(result.warnings).toEqual([
    {
      worktreeId: "worktree-0",
      message: expect.stringContaining("GitLab pipelines"),
    },
  ]);
});

test("reports stale pipeline fallback and does not overwrite the last good client metadata", async () => {
  gitlab.pipelinesForCommit.mockImplementation(
    async (_project, _sha, options) => {
      options.onWarning("GitLab timed out; showing saved status");
      return [];
    },
  );
  const result = await service().enrichment({
    kind: "GITLAB_PIPELINES",
    worktreeId: "worktree-1",
  });
  expect(result.updates).toEqual([]);
  expect(result.warnings[0]).toEqual({
    worktreeId: "worktree-1",
    message: "GitLab timed out; showing saved status",
  });
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        missingAt: null,
        codebase: {
          repository: {
            codebases: { some: { worktrees: { some: { id: "worktree-1" } } } },
          },
        },
      },
      include: expect.anything(),
    }),
  );
});
