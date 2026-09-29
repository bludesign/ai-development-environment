import { afterEach, describe, expect, test, vi } from "vitest";

import type { GitLabMergeService } from "./gitlab-merge.service";
import { GitLabService } from "./gitlab.service";

const author = {
  id: 7,
  username: "alex",
  name: "Alex",
  web_url: "https://gitlab.example/alex",
};
const mergeRequest = {
  id: 1042,
  iid: 42,
  project_id: 21,
  source_project_id: 21,
  title: "Improve API retries",
  state: "opened",
  description: "",
  source_branch: "feature/api",
  target_branch: "main",
  sha: "abcdef123",
  author,
  web_url: "https://gitlab.example/team/app/-/merge_requests/42",
  created_at: "2026-09-20T12:00:00Z",
  updated_at: "2026-09-20T12:01:00Z",
  detailed_merge_status: "mergeable",
};
const syntheticPipeline = {
  id: 94,
  ref: "refs/merge-requests/42/merge",
  sha: mergeRequest.sha,
  source: "merge_request_event",
  status: "success",
  web_url: "https://gitlab.example/team/app/-/pipelines/94",
};

type Approval = {
  approvals_required?: number;
  approvals_left?: number;
  approved_by?: unknown[];
};
type Read = { operation: string; query?: Record<string, unknown> };
type Response = { data: unknown; headers: Headers };
function setup({
  approval = { approvals_required: 0, approvals_left: 0 },
  discussions = [],
  pipelines = [],
  readiness = "mergeable",
  context = {},
}: {
  approval?: Approval | Error;
  discussions?: unknown[] | Error;
  pipelines?: unknown[];
  readiness?: string;
  context?: { worktreeId?: string; worktreeHighlightColor?: string };
} = {}) {
  const service = new GitLabService();
  service.setMergeCoordinator({
    summary: vi.fn(async () => context),
  } as unknown as GitLabMergeService);
  const read = vi
    .spyOn(service as unknown as { get(input: Read): Promise<Response> }, "get")
    .mockImplementation(async ({ operation }) => {
      const current = {
        ...mergeRequest,
        detailed_merge_status: readiness,
        head_pipeline: syntheticPipeline,
      };
      let data: unknown;
      if (operation === "GitLabMergeRequests") data = [current];
      else if (operation === "GitLabMergeRequest") data = current;
      else if (operation === "GitLabMergeRequestApprovals") {
        if (approval instanceof Error) throw approval;
        data = approval;
      } else if (operation === "GitLabMergeRequestDiscussions") {
        if (discussions instanceof Error) throw discussions;
        data = discussions;
      } else if (operation === "GitLabMergeRequestPipelines") data = pipelines;
      else if (operation === "GitLabMergeRequestCommits")
        data = [{ id: mergeRequest.sha }];
      else throw new Error(`Unexpected read: ${operation}`);
      return { data, headers: new Headers() };
    });
  return { service, read };
}

afterEach(() => vi.restoreAllMocks());

describe("GitLab merge request metadata", () => {
  test.each([
    {
      approval: { approvals_required: 2, approved_by: [{ user: author }] },
      expected: null,
      left: null,
    },
    {
      approval: {
        approvals_required: 2,
        approvals_left: 1,
        approved_by: [{ user: author }],
      },
      expected: "REVIEW_REQUIRED",
      left: 1,
    },
    {
      approval: {
        approvals_required: 2,
        approvals_left: 0,
        approved_by: [{ user: author }],
      },
      expected: "APPROVED",
      left: 0,
    },
    {
      approval: { approvals_required: 0, approvals_left: 0, approved_by: [] },
      expected: "NOT_REQUIRED",
      left: 0,
    },
  ])(
    "reports $expected without treating a partial approval as completion",
    async ({ approval, expected, left }) => {
      const { service } = setup({ approval });
      const { items } = await service.mergeRequests({ scope: "MINE" });
      expect(items[0].approvalState).toBe(expected);
      expect(items[0].approvalsRequired).toBe(approval.approvals_required);
      expect(items[0].approvalsLeft).toBe(left);
    },
  );

  test("returns unavailable optional metadata when provider reads fail, not false zero counts", async () => {
    const { service } = setup({
      approval: new Error("Forbidden"),
      discussions: new Error("GitLab unavailable"),
    });
    const { items } = await service.mergeRequests({ scope: "MINE" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: mergeRequest.title,
      approvalState: null,
      approvalsRequired: null,
      approvalsLeft: null,
      unresolvedDiscussionsCount: null,
    });
  });

  test("reports a real zero for a successful empty discussion response", async () => {
    const { service } = setup();
    const { items } = await service.mergeRequests({ scope: "MINE" });
    expect(items[0].unresolvedDiscussionsCount).toBe(0);
    expect(items[0].approvalState).toBe("NOT_REQUIRED");
  });

  test("counts unresolved discussions rather than notes, and preserves requested changes without approval data", async () => {
    const note = {
      id: 1,
      body: "Please fix",
      author,
      resolvable: true,
      created_at: mergeRequest.created_at,
      updated_at: mergeRequest.updated_at,
      system: false,
    };
    const { service } = setup({
      approval: new Error("Forbidden"),
      readiness: "requested_changes",
      discussions: [
        {
          id: "thread-1",
          individual_note: false,
          notes: [note, { ...note, id: 2 }],
        },
        {
          id: "thread-2",
          individual_note: false,
          notes: [{ ...note, id: 3, resolved: true }],
        },
        {
          id: "note",
          individual_note: true,
          notes: [{ ...note, id: 4, resolvable: false }],
        },
      ],
    });
    const { items } = await service.mergeRequests({ scope: "MINE" });
    expect(items[0].approvalState).toBe("CHANGES_REQUESTED");
    expect(items[0].unresolvedDiscussionsCount).toBe(1);
  });
});

describe("GitLab merge request pipeline context", () => {
  test("keeps a queued pipeline's missing start time separate from its creation time", async () => {
    const createdAt = "2026-09-20T12:00:00Z";
    const { service } = setup({
      pipelines: [
        { ...syntheticPipeline, status: "pending", created_at: createdAt },
      ],
    });
    const detail = await service.mergeRequest("21", 42);
    expect(detail.pipelines[0]).toMatchObject({
      status: "PENDING",
      createdAt,
      startedAt: null,
      duration: null,
      queuedDuration: null,
    });
  });

  test("uses the known request and worktree to resolve synthetic pipeline refs without additional provider reads", async () => {
    const { service, read } = setup({
      pipelines: [syntheticPipeline],
      context: { worktreeId: "worktree-1", worktreeHighlightColor: "violet" },
    });
    const detail = await service.mergeRequest("21", 42);
    const expected = {
      projectId: "21",
      branch: "feature/api",
      ref: "refs/merge-requests/42/merge",
      worktreeId: "worktree-1",
      worktreeHighlightColor: "violet",
      mergeRequests: [
        {
          projectId: "21",
          iid: 42,
          title: mergeRequest.title,
          webUrl: mergeRequest.web_url,
          sourceBranch: "feature/api",
        },
      ],
    };
    expect(detail.pipelines[0]).toMatchObject(expected);
    expect(detail.headPipeline).toMatchObject(expected);
    expect(detail.unresolvedDiscussionsCount).toBe(0);
    expect(
      read.mock.calls.filter(
        ([input]) => input.operation === "GitLabMergeRequestDiscussions",
      ),
    ).toHaveLength(1);
    expect(
      read.mock.calls.some(
        ([input]) => input.operation === "GitLabPipelineMergeRequests",
      ),
    ).toBe(false);
  });

  test("keeps ordinary refs and does not attach a source worktree to a different branch", async () => {
    const { service } = setup({
      pipelines: [
        { ...syntheticPipeline, project_id: 22, ref: "main", source: "push" },
      ],
      context: { worktreeId: "worktree-1", worktreeHighlightColor: "violet" },
    });
    const detail = await service.mergeRequest("21", 42);
    expect(detail.pipelines[0]).toMatchObject({
      projectId: "22",
      branch: "main",
      worktreeId: null,
      worktreeHighlightColor: null,
    });
    expect(detail.pipelines[0].mergeRequests[0].iid).toBe(42);
  });

  test("keeps unavailable source metadata unknown and propagates required detail failures", async () => {
    const { service } = setup({
      pipelines: [{ ...syntheticPipeline, source: undefined }],
    });
    const detail = await service.mergeRequest("21", 42);
    expect(detail.pipelines[0]).toMatchObject({
      source: "unknown",
      branch: "feature/api",
    });
    const failing = setup({ discussions: new Error("Forbidden") });
    await expect(failing.service.mergeRequest("21", 42)).rejects.toThrow(
      "Forbidden",
    );
  });
});
