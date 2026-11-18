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
    request(query: string): Promise<unknown>;
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
        nodes: conclusions.map((conclusion, index) => ({
          __typename: "CheckRun",
          id: `check-${index}`,
          status: "COMPLETED",
          conclusion,
          checkSuite: {
            id: `suite-${index}`,
            status: "COMPLETED",
            conclusion,
            repository: { id: "source-repo" },
            workflowRun: {
              databaseId: 1,
              runAttempt: 1,
              url: "https://github.com/fork/repo/actions/runs/1",
              workflow: { name: "CI" },
            },
          },
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
  const state = {
    pullRequest: pr,
    repositoryId: "base-repo",
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
  test("uses each check suite's repository and falls back to the base repository for statuses", async () => {
    const f = githubFixture(["FAILURE"], "FAILURE");
    f.pr.statusCheckRollup.contexts.pageInfo = {
      hasNextPage: true,
      endCursor: "cursor",
    } as never;
    f.mergeState.mockRestore();
    const baseCheck = f.pr.statusCheckRollup.contexts.nodes[0]!;
    f.request
      .mockResolvedValueOnce({
        viewer: { email: "" },
        repository: {
          id: "base-repo",
          viewerPermission: "WRITE",
          squashMergeAllowed: true,
          pullRequest: f.pr,
        },
      })
      .mockResolvedValueOnce({
        node: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  ...baseCheck,
                  checkSuite: {
                    ...baseCheck.checkSuite,
                    id: "base-suite",
                    repository: { id: "base-repo" },
                    workflowRun: {
                      ...baseCheck.checkSuite.workflowRun,
                      url: "https://github.com/team/repo/actions/runs/1",
                    },
                  },
                },
                {
                  __typename: "StatusContext",
                  id: "external-status",
                  state: "ERROR",
                  targetUrl: null,
                  updatedAt: "2026-11-18T18:00:00Z",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    const ready = await f.service.managedMergeReadiness("team", "repo", 1);
    expect(ready.pipelineCI?.failures).toEqual([
      {
        provider: "GITHUB",
        id: "suite-0",
        repositoryGithubId: "source-repo",
        workflowRunId: "1",
        headSha: head,
        status: "FAILURE",
        url: "https://github.com/fork/repo/actions/runs/1",
      },
      {
        provider: "GITHUB",
        id: "base-suite",
        repositoryGithubId: "base-repo",
        workflowRunId: "1",
        headSha: head,
        status: "FAILURE",
        url: "https://github.com/team/repo/actions/runs/1",
      },
      {
        provider: "GITHUB",
        id: "external-status",
        repositoryGithubId: "base-repo",
        headSha: head,
        status: "ERROR",
        url: null,
      },
    ]);
    expect(f.request.mock.calls.map(([query]) => query)).toEqual([
      expect.stringContaining("repository { id }"),
      expect.stringContaining("repository { id }"),
    ]);
  });

  test.each<[string[], string, string | undefined]>([
    [["CANCELLED"], "FAILURE", "CANCELLED"],
    [["STALE"], "FAILURE", "STALE"],
    [["SKIPPED"], "SUCCESS", "SKIPPED"],
    [["CANCELLED", "QUEUED"], "FAILURE", undefined],
  ])(
    "reports a terminal block only after checks settle: %j",
    async (conclusions, rollup, status) => {
      const f = githubFixture(conclusions, rollup);
      const { pipelineCI } = await f.service.managedMergeReadiness(
        "team",
        "repo",
        1,
      );
      expect(pipelineCI).toMatchObject({ passed: false, failures: [] });
      expect(pipelineCI?.terminalStatus).toBe(status);
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
      id: "pipeline",
      projectId: "target-project",
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
  test("only reports a synthetic failure when both parents match the request", async () => {
    const synthetic = "c".repeat(40);
    const stale = gitlabFixture("FAILED", synthetic, ["old-source", target]);
    const matching = gitlabFixture("FAILED", synthetic, [head, target]);
    expect(
      (await stale.service.managedMergeReadiness("project", 1)).pipelineCI
        ?.failures,
    ).toEqual([]);
    expect(
      (await matching.service.managedMergeReadiness("project", 1)).pipelineCI
        ?.failures,
    ).toMatchObject([
      {
        provider: "GITLAB",
        id: "pipeline",
        headSha: synthetic,
        status: "FAILED",
      },
    ]);
  });

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

function gitlabBranchFixture() {
  const service = new GitLabService();
  const internal = service as unknown as {
    projectForCanonicalOrigin(): Promise<unknown>;
    get(input: { path: string }): Promise<unknown>;
    allPages(): Promise<unknown[]>;
  };
  const mergeRequest = {
    id: 17,
    iid: 3,
    project_id: 20,
    source_project_id: 10,
    state: "opened",
    source_branch: "feature",
    target_branch: "release",
    sha: head,
    author: { id: 1, username: "user" },
    head_pipeline: {
      id: 14,
      project_id: 10,
      sha: head,
      ref: "refs/merge-requests/3/head",
      source: "merge_request_event",
      status: "failed",
      web_url: "https://gitlab.test/fork/repo/-/pipelines/14",
    },
  };
  const parents = [head, target];
  const branchPipelines: unknown[] = [];
  vi.spyOn(internal, "projectForCanonicalOrigin").mockResolvedValue({
    id: "10",
  });
  vi.spyOn(internal, "allPages").mockResolvedValue(branchPipelines);
  const get = vi.spyOn(internal, "get").mockImplementation(async ({ path }) => {
    if (path === "/projects/10/repository/branches/feature")
      return { data: { commit: { id: head } } };
    if (path === "/projects/20/repository/branches/release")
      return { data: { commit: { id: target } } };
    if (path === "/projects/20/merge_requests/3") return { data: mergeRequest };
    if (
      path ===
      `/projects/10/repository/commits/${mergeRequest.head_pipeline.sha}`
    )
      return { data: { parent_ids: parents } };
    throw new Error(`Unexpected GitLab path ${path}`);
  });
  const observe = () =>
    service.branchPipelineCI("gitlab.test/fork/repo", "feature", {
      projectId: "20",
      iid: 3,
    });
  return { observe, mergeRequest, parents, branchPipelines, get };
}

describe("GitLab standalone branch CI", () => {
  test("includes a freshly linked merge-request-only failure on the branch head", async () => {
    const f = gitlabBranchFixture();
    expect(await f.observe()).toMatchObject({
      headSha: head,
      ci: {
        passed: false,
        failures: [
          {
            provider: "GITLAB",
            id: "14",
            projectId: "10",
            headSha: head,
            status: "FAILED",
          },
        ],
      },
    });
    expect(f.get).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/projects/20/merge_requests/3",
        force: true,
        allowStaleOnError: false,
      }),
    );
  });

  test.each([
    { state: "closed" },
    { project_id: 21 },
    { iid: 4 },
    { source_project_id: 11 },
    { source_branch: "other" },
    { sha: "old-source" },
  ])(
    "ignores a stale or unrelated linked merge request: %j",
    async (invalidFields) => {
      const f = gitlabBranchFixture();
      Object.assign(f.mergeRequest, invalidFields);
      expect(await f.observe()).toEqual({
        headSha: head,
        ci: { passed: false, failures: [] },
      });
    },
  );

  test("accepts a successful synthetic merge request pipeline only for current parents", async () => {
    const f = gitlabBranchFixture();
    const synthetic = "c".repeat(40);
    Object.assign(f.mergeRequest.head_pipeline, {
      sha: synthetic,
      status: "success",
      ref: "refs/merge-requests/3/merge",
    });
    expect(await f.observe()).toEqual({
      headSha: head,
      ci: { passed: true, failures: [] },
    });
    expect(f.get).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/projects/10/repository/commits/${synthetic}`,
        force: true,
        allowStaleOnError: false,
      }),
    );
    f.parents[1] = "old-target";
    expect(await f.observe()).toEqual({
      headSha: head,
      ci: { passed: false, failures: [] },
    });
  });

  test("waits for a linked running pipeline before acting on branch failures", async () => {
    const f = gitlabBranchFixture();
    f.branchPipelines.push({
      ...f.mergeRequest.head_pipeline,
      id: 15,
      source: "push",
      ref: "feature",
    });
    f.mergeRequest.head_pipeline.status = "running";
    expect(await f.observe()).toEqual({
      headSha: head,
      ci: { passed: false, failures: [] },
    });
  });

  test("reports a matching manual pipeline as blocked", async () => {
    const f = gitlabBranchFixture();
    f.mergeRequest.head_pipeline.status = "manual";
    expect(await f.observe()).toEqual({
      headSha: head,
      ci: { passed: false, failures: [], terminalStatus: "MANUAL" },
    });
  });
});
