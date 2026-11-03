import { describe, expect, test, vi } from "vitest";
import { GitHubService } from "@/services/github/github.service";
import { GitLabService } from "@/services/gitlab/gitlab.service";

const head = "a".repeat(40),
  target = "b".repeat(40);

function githubFixture(
  conclusions: string[] = ["SUCCESS"],
  rollup = "SUCCESS",
) {
  const service = new GitHubService();
  const internal = service as unknown as {
    requireToken(): Promise<string>;
    mergeState(): Promise<unknown>;
    remainingPipelineContexts(): Promise<unknown[]>;
    request(): Promise<unknown>;
  };
  vi.spyOn(internal, "requireToken").mockResolvedValue("token");
  const pr = {
    id: "pr",
    state: "OPEN",
    isDraft: false,
    headRefOid: head,
    headRefName: "feature",
    headRepository: { nameWithOwner: "fork/repo" },
    baseRefName: "release",
    baseRefOid: target,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: null,
    statusCheckRollup: {
      state: rollup,
      contexts: {
        nodes: conclusions.map((conclusion) => ({
          __typename: "CheckRun",
          status: "COMPLETED",
          conclusion,
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
  const state = {
    pullRequest: pr,
    viewerPermission: "WRITE",
    availableMethods: ["SQUASH"],
  };
  const mergeState = vi.spyOn(internal, "mergeState").mockResolvedValue(state);
  const request = vi.spyOn(internal, "request").mockResolvedValue({
    mergePullRequest: { pullRequest: { id: "pr", state: "MERGED" } },
  });
  return { service, internal, pr, state, mergeState, request };
}

describe("GitHub managed merge readiness", () => {
  test.each([
    [[], "SUCCESS", false],
    [["SKIPPED"], "SUCCESS", false],
    [["NEUTRAL"], "SUCCESS", false],
    [["FAILURE"], "FAILURE", false],
    [["CANCELLED"], "FAILURE", false],
    [["SUCCESS"], "PENDING", false],
    [["SUCCESS"], "SUCCESS", true],
    [["SUCCESS", "SKIPPED"], "SUCCESS", true],
  ])(
    "requires an actual successful current check: %j / %s",
    async (conclusions, rollup, passed) => {
      const f = githubFixture(conclusions as string[], rollup as string);
      expect(
        (await f.service.managedMergeReadiness("team", "repo", 1)).ciPassed,
      ).toBe(passed);
      expect(f.mergeState).toHaveBeenCalledWith(
        "team",
        "repo",
        1,
        "token",
        "WORKTREE_AUTOMATION",
        true,
        true,
      );
    },
  );
  test("includes paginated check contexts before allowing a merge", async () => {
    const f = githubFixture();
    f.pr.statusCheckRollup.contexts.pageInfo = {
      hasNextPage: true,
      endCursor: "cursor",
    } as never;
    vi.spyOn(f.internal, "remainingPipelineContexts").mockResolvedValue([
      { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
    ]);
    expect(
      (await f.service.managedMergeReadiness("team", "repo", 1)).ciPassed,
    ).toBe(false);
  });
  test.each(["source", "target"])(
    "rejects a changed %s before the merge mutation",
    async (changed) => {
      const f = githubFixture();
      if (changed === "source") f.pr.headRefOid = "c".repeat(40);
      else f.pr.baseRefOid = "c".repeat(40);
      await expect(
        f.service.mergePullRequest({
          owner: "team",
          name: "repo",
          number: 1,
          method: "SQUASH",
          commitHeadline: "Merge",
          commitBody: "",
          expectedHeadSha: head,
          expectedTargetSha: target,
        }),
      ).rejects.toThrow("changed before merging");
      expect(f.request).not.toHaveBeenCalled();
    },
  );
});

function gitlabFixture(
  status = "SUCCESS",
  pipelineSha = head,
  parents: string[] = [],
) {
  const service = new GitLabService();
  const internal = service as unknown as {
    mergeReadiness(): Promise<unknown>;
    mergeProject(): Promise<unknown>;
    get(input: { path: string }): Promise<unknown>;
  };
  const mr = {
    state: "OPENED",
    sha: head,
    sourceProjectId: "fork",
    sourceBranch: "feature",
    targetBranch: "release",
    detailedMergeStatus: "mergeable",
    draft: false,
    hasConflicts: false,
    mergeWhenPipelineSucceeds: false,
    headPipeline: {
      status,
      sha: pipelineSha,
      source: "merge_request_event",
    } as Record<string, unknown> | null,
  };
  vi.spyOn(internal, "mergeReadiness").mockResolvedValue({
    mr,
    canMerge: true,
    project: { web_url: "https://gitlab.test/team/repo" },
  });
  vi.spyOn(internal, "mergeProject").mockResolvedValue({
    web_url: "https://gitlab.test/fork/repo",
  });
  const get = vi
    .spyOn(internal, "get")
    .mockImplementation(async ({ path }) => ({
      data: path.includes("/branches/")
        ? { commit: { id: target } }
        : { parent_ids: parents },
    }));
  return { service, mr, get };
}

describe("GitLab managed merge readiness", () => {
  test.each(["RUNNING", "FAILED", "CANCELED", "SKIPPED", "MANUAL"])(
    "does not merge with %s CI",
    async (status) => {
      const f = gitlabFixture(status);
      expect(
        (await f.service.managedMergeReadiness("project", 1)).ciPassed,
      ).toBe(false);
    },
  );
  test("does not accept an older pipeline or missing CI", async () => {
    const f = gitlabFixture("SUCCESS", "old");
    expect((await f.service.managedMergeReadiness("project", 1)).ciPassed).toBe(
      false,
    );
    f.mr.headPipeline = null;
    expect((await f.service.managedMergeReadiness("project", 1)).ciPassed).toBe(
      false,
    );
  });
  test("accepts current source CI and uses the actual target repository and branch", async () => {
    const f = gitlabFixture();
    expect(await f.service.managedMergeReadiness("project", 1)).toMatchObject({
      ciPassed: true,
      targetBranch: "release",
      targetOrigin: "gitlab.test/team/repo",
      sourceOrigin: "gitlab.test/fork/repo",
      targetSha: target,
    });
    expect(f.get).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/projects/project/repository/branches/release",
        force: true,
        allowStaleOnError: false,
      }),
    );
  });
  test("accepts a merged-result pipeline only for the current source and target parents", async () => {
    const f = gitlabFixture("SUCCESS", "synthetic", [head, target]);
    expect((await f.service.managedMergeReadiness("project", 1)).ciPassed).toBe(
      true,
    );
    const stale = gitlabFixture("SUCCESS", "synthetic", [head, "old-target"]);
    expect(
      (await stale.service.managedMergeReadiness("project", 1)).ciPassed,
    ).toBe(false);
  });
});
