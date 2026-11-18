import { expect, test } from "vitest";

import type { GitLabPipelineView } from "@/services/gitlab/types";

import { failingGitLabPipelines } from "./worktree-failing-pipelines";

const worktree = {
  branch: "feature/ci",
  headSha: "head",
  sourceControlRequest: null,
};

function pipeline(
  id: string,
  ref: string,
  fields: Partial<GitLabPipelineView> = {},
): GitLabPipelineView {
  return {
    id,
    projectId: "44",
    iid: null,
    ref,
    branch: ref,
    sha: "head",
    source: "push",
    status: "FAILED",
    webUrl: `https://gitlab.example/pipelines/${id}`,
    mergeRequests: [],
    worktreeId: null,
    worktreeHighlightColor: null,
    startedAt: null,
    createdAt: null,
    updatedAt: null,
    finishedAt: null,
    duration: null,
    queuedDuration: null,
    ...fields,
  };
}

test("selects the current branch before deduplicating GitLab pipeline status", () => {
  const failed = pipeline("10", "refs/heads/feature/ci");
  const unrelated = [
    pipeline("11", "other-branch", { status: "SUCCESS" }),
    pipeline("12", "refs/tags/feature/ci"),
    pipeline("13", "feature/ci", { sha: "previous-head" }),
    pipeline("14", "different-branch"),
  ];
  expect(
    failingGitLabPipelines([failed, ...unrelated], worktree).map(
      ({ id }) => id,
    ),
  ).toEqual(["10"]);

  const recovered = pipeline("15", "feature/ci", { status: "SUCCESS" });
  expect(
    failingGitLabPipelines([failed, ...unrelated, recovered], worktree),
  ).toEqual([]);
});

test("matches a saved synthetic GitLab ref to the worktree's merge request", () => {
  const failed = pipeline("10", "refs/merge-requests/5/head", {
    source: "merge_request_event",
  });
  const unrelated = pipeline("11", "refs/merge-requests/15/head", {
    source: "merge_request_event",
    status: "SUCCESS",
  });
  const wrongProject = pipeline("12", failed.ref, { projectId: "45" });
  const linkedWorktree = {
    ...worktree,
    sourceControlRequest: {
      provider: "GITLAB" as const,
      id: "123",
      number: 5,
      projectId: "44",
      headRefName: "feature/ci",
      headRefOid: "head",
      title: "CI changes",
      url: "https://gitlab.example/merge_requests/5",
      isDraft: false,
      createdAt: "",
    },
  };
  expect(
    failingGitLabPipelines(
      [failed, unrelated, wrongProject],
      linkedWorktree,
    ).map(({ id }) => id),
  ).toEqual(["10"]);
});

test("accepts an enriched association only for the ref's project and merge request", () => {
  const ref = "refs/merge-requests/5/head";
  const mergeRequest = {
    projectId: "44",
    iid: 5,
    title: "CI changes",
    webUrl: "https://gitlab.example/merge_requests/5",
    sourceBranch: "feature/ci",
  };
  const failed = pipeline("10", ref, {
    source: "merge_request_event",
    mergeRequests: [mergeRequest],
  });
  const wrongIid = pipeline("11", "refs/merge-requests/15/head", {
    source: "merge_request_event",
    mergeRequests: [mergeRequest],
  });
  const wrongBranch = pipeline("12", ref, {
    source: "merge_request_event",
    mergeRequests: [{ ...mergeRequest, sourceBranch: "other-branch" }],
  });
  const recoveredOtherRequest = pipeline("13", "refs/merge-requests/8/head", {
    source: "merge_request_event",
    status: "SUCCESS",
    mergeRequests: [{ ...mergeRequest, iid: 8 }],
  });
  expect(
    failingGitLabPipelines(
      [failed, wrongIid, wrongBranch, recoveredOtherRequest],
      worktree,
    ).map(({ id }) => id),
  ).toEqual(["10"]);
});
