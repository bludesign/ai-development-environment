import { beforeEach, describe, expect, test, vi } from "vitest";

const updateMany = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({ gitLabPipelineRecord: { updateMany } }),
}));

import { externalPipelineActionsService } from "./external-pipeline-actions";
import { GitLabService } from "./gitlab.service";

type Read = { path: string; query: Record<string, unknown>; force?: boolean };
type Response = { data: unknown[]; headers: Headers };
const job = (id: number) => ({
  id,
  pipeline: { id: 94 },
  name: `test-${id}`,
  stage: "test",
  status:
    id === 1 ? "canceling" : id === 2 ? "waiting_for_callback" : "success",
  ref: "main",
  web_url: `https://gitlab.example/jobs/${id}`,
  allow_failure: false,
  retried: id === 3,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
});

describe("GitLab pipeline details", () => {
  test("resolves synthetic fork MR refs when commit associations omit the merge SHA", async () => {
    const service = new GitLabService();
    const pipeline = {
      id: "94",
      projectId: "21",
      ref: "refs/merge-requests/2/merge",
      sha: "merge-sha",
      source: "merge_request_event",
    } as Awaited<ReturnType<GitLabService["pipeline"]>>;
    vi.spyOn(
      service as unknown as {
        pipelineWorktrees(): Promise<Map<string, unknown>>;
      },
      "pipelineWorktrees",
    ).mockResolvedValue(new Map());
    const read = vi
      .spyOn(
        service as unknown as {
          get(input: Read): Promise<{ data: unknown; headers: Headers }>;
        },
        "get",
      )
      .mockImplementation(async (input) => ({
        data: input.path.endsWith("/merge_requests/2")
          ? {
              project_id: 21,
              source_project_id: 22,
              iid: 2,
              title: "Fork MR",
              web_url: "https://gitlab.example/mr/2",
              source_branch: "fork-feature",
              target_branch: "main",
            }
          : [],
        headers: new Headers(),
      }));
    const result = await (
      service as unknown as {
        enrichPipelines(
          projectId: string,
          pipelines: (typeof pipeline)[],
        ): Promise<(typeof pipeline)[]>;
      }
    ).enrichPipelines("21", [pipeline]);
    expect(result[0]).toMatchObject({
      branch: "fork-feature",
      ref: pipeline.ref,
      sha: "merge-sha",
      mergeRequests: [
        {
          iid: 2,
          sourceProjectId: "22",
          targetProjectId: "21",
          targetBranch: "main",
        },
      ],
    });
    expect(read.mock.calls.map(([input]) => input.path)).toContain(
      "/projects/21/merge_requests/2",
    );
  });

  test("paginates external history and uses GitLab's current statuses across reporting-account changes", async () => {
    const service = new GitLabService();
    const pipeline = {
      id: "94",
      projectId: "21",
      sha: "abc",
      ref: "main",
      branch: "main",
      webUrl: "https://gitlab.example/pipelines/94",
    } as Awaited<ReturnType<GitLabService["pipeline"]>>;
    vi.spyOn(service, "pipeline").mockResolvedValue(pipeline);
    vi.spyOn(
      externalPipelineActionsService,
      "repositoryForProject",
    ).mockResolvedValue(null);
    const status = (id: number, author: number, state = "failed") => ({
      id,
      pipeline_id: 94,
      name: "ci/external",
      status: state,
      author: { id: author, name: "CI", username: "ci" },
    });
    const read = vi
      .spyOn(
        service as unknown as { get(input: Read): Promise<Response> },
        "get",
      )
      .mockImplementation(async (input) => {
        if (input.path.endsWith("/jobs"))
          return { data: [job(1)], headers: new Headers() };
        if (input.path.endsWith("/bridges"))
          return { data: [job(2)], headers: new Headers() };
        if (input.query.all === false)
          return { data: [status(104, 8, "success")], headers: new Headers() };
        if (input.query.page === 1)
          return {
            data: [status(100, 7), status(1, 7), status(2, 7)],
            headers: new Headers({ "x-next-page": "2" }),
          };
        return {
          data: [
            status(104, 8, "success"),
            status(104, 8, "success"),
            { ...status(200, 9), pipeline_id: 95 },
          ],
          headers: new Headers(),
        };
      });
    const jobs = await service.pipelineJobs("21", "94", true);
    expect(jobs).toHaveLength(4);
    expect(jobs.find((job) => job.id === "2")?.kind).toBe("BRIDGE");
    expect(jobs.find((job) => job.id === "100")).toMatchObject({
      kind: "EXTERNAL",
      retried: true,
      canRetry: false,
    });
    expect(jobs.find((job) => job.id === "104")).toMatchObject({
      kind: "EXTERNAL",
      retried: false,
      author: { id: "8" },
    });
    expect(
      read.mock.calls
        .filter(([input]) => input.query.all === true)
        .map(([input]) => input.query.page),
    ).toEqual([1, 2]);
    expect(
      read.mock.calls.find(([input]) => input.query.all === false)?.[0].query,
    ).toMatchObject({ pipeline_id: "94", all: false });
  });

  test("loads more than 100 jobs, keeps retry history and stores only the matching project's records", async () => {
    const service = new GitLabService();
    vi.spyOn(service, "pipeline").mockResolvedValue({
      id: "94",
      projectId: "project/21",
      sha: "abc",
      ref: "main",
      webUrl: "https://gitlab.example/pipelines/94",
    } as Awaited<ReturnType<GitLabService["pipeline"]>>);
    vi.spyOn(
      externalPipelineActionsService,
      "repositoryForProject",
    ).mockResolvedValue(null);
    const read = vi
      .spyOn(
        service as unknown as { get(input: Read): Promise<Response> },
        "get",
      )
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => job(index + 1)),
        headers: new Headers({ "x-next-page": "2" }),
      })
      .mockResolvedValueOnce({
        data: Array.from({ length: 23 }, (_, index) => job(index + 101)),
        headers: new Headers(),
      })
      .mockResolvedValue({ data: [], headers: new Headers() });
    const jobs = await service.pipelineJobs("project/21", "94");
    expect(jobs).toHaveLength(123);
    expect(jobs[0].status).toBe("CANCELING");
    expect(jobs[1].status).toBe("WAITING_FOR_CALLBACK");
    expect(jobs[2].retried).toBe(true);
    expect(read.mock.calls.slice(0, 2).map(([input]) => input.query)).toEqual([
      { include_retried: true, per_page: 100, page: 1 },
      { include_retried: true, per_page: 100, page: 2 },
    ]);
    expect(
      read.mock.calls
        .slice(0, 2)
        .every(
          ([input]) =>
            input.force &&
            input.path === "/projects/project%2F21/pipelines/94/jobs",
        ),
    ).toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pipelineId: "94", snapshot: { projectId: "project/21" } },
      }),
    );
    expect(JSON.parse(updateMany.mock.calls[0][0].data.jobsJson)).toHaveLength(
      123,
    );
  });

  test("rejects repeated provider pagination cursors instead of storing incomplete details", async () => {
    const service = new GitLabService();
    vi.spyOn(
      service as unknown as { get(input: Read): Promise<Response> },
      "get",
    ).mockResolvedValue({
      data: [job(1)],
      headers: new Headers({ "x-next-page": "1" }),
    });
    await expect(service.pipelineJobs("21", "94")).rejects.toThrow(
      "repeated pagination cursor",
    );
    expect(updateMany).not.toHaveBeenCalled();
  });
});
