import { beforeEach, describe, expect, test, vi } from "vitest";

const updateMany = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({ gitLabPipelineRecord: { updateMany } }),
}));

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
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
});

describe("GitLab pipeline details", () => {
  test("loads more than 100 jobs, keeps retry history and stores only the matching project's records", async () => {
    const service = new GitLabService();
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
      });
    const jobs = await service.pipelineJobs("project/21", "94");
    expect(jobs).toHaveLength(123);
    expect(jobs[0].status).toBe("CANCELING");
    expect(jobs[1].status).toBe("WAITING_FOR_CALLBACK");
    expect(jobs[2].retried).toBe(true);
    expect(read.mock.calls.map(([input]) => input.query)).toEqual([
      { include_retried: true, per_page: 100, page: 1 },
      { include_retried: true, per_page: 100, page: 2 },
    ]);
    expect(
      read.mock.calls.every(
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
