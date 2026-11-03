import { afterEach, describe, expect, test, vi } from "vitest";
import { GitLabRequestError, GitLabService } from "./gitlab.service";
import type { GitLabMergeRequestView, GitLabPipelineView } from "./types";

const database = vi.hoisted(() => ({
  gitLabProject: { findUnique: vi.fn() },
  codebase: { findMany: vi.fn() },
}));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => database,
}));

const user = {
  id: 7,
  username: "alice",
  name: "Alice",
  web_url: "https://gitlab.example/alice",
};
const mr = (
  project: number,
  iid: number,
  updated = "2026-11-01T12:00:00Z",
) => ({
  id: project * 100 + iid,
  project_id: project,
  source_project_id: project,
  iid,
  title: `Request ${iid}`,
  state: "opened",
  web_url: `https://gitlab.example/team/app/-/merge_requests/${iid}`,
  source_branch: "feature",
  target_branch: "main",
  sha: "head",
  author: user,
  created_at: updated,
  updated_at: updated,
});
const pipeline = (id: number, ref: string, status = "running") => ({
  id,
  project_id: 1,
  ref,
  sha: `sha-${id}`,
  source: "push",
  status,
  web_url: `https://gitlab.example/pipelines/${id}`,
});
type ReadInput = {
  path: string;
  query?: Record<string, unknown>;
  force?: boolean;
  operation?: string;
};
type Internals = {
  get(input: ReadInput): Promise<{ data: unknown[]; headers: Headers }>;
  enrichMergeRequest(
    value: GitLabMergeRequestView,
  ): Promise<GitLabMergeRequestView>;
  enrichPipelines(
    project: string,
    values: GitLabPipelineView[],
  ): Promise<GitLabPipelineView[]>;
  observePipelines(values: GitLabPipelineView[]): Promise<void>;
};

function setup() {
  const service = new GitLabService();
  const internal = service as unknown as Internals;
  vi.spyOn(service, "getSettings").mockResolvedValue({
    configured: true,
  } as never);
  vi.spyOn(service, "projects").mockResolvedValue([
    { id: "1", enabled: true },
    { id: "2", enabled: true },
    { id: "3", enabled: false },
  ] as never);
  vi.spyOn(internal, "enrichMergeRequest").mockImplementation(
    async (value) => value,
  );
  vi.spyOn(internal, "enrichPipelines").mockImplementation(
    async (_project, values) => values,
  );
  vi.spyOn(internal, "observePipelines").mockResolvedValue();
  const read = vi.spyOn(internal, "get").mockResolvedValue({
    data: [],
    headers: new Headers({ "x-next-page": "" }),
  });
  database.gitLabProject.findUnique.mockResolvedValue({
    webUrl: "https://gitlab.example/team/app",
  });
  database.codebase.findMany.mockResolvedValue([
    { branch: "main", worktrees: [{ branch: "feature" }] },
  ]);
  return { service, internal, read };
}
afterEach(() => vi.restoreAllMocks());

describe("GitLab user and managed project scopes", () => {
  test("reads only enabled managed project authored requests before enrichment and sorts pagination deterministically", async () => {
    const { service, read } = setup();
    read.mockImplementation(async ({ path, query }) => {
      expect(query).toMatchObject({ scope: "created_by_me", state: "opened" });
      return {
        data: path.startsWith("/projects/1/") ? [mr(1, 1)] : [mr(2, 2)],
        headers: new Headers({ "x-next-page": "" }),
      };
    });
    const first = await service.mergeRequests({
      scope: "MINE",
      projectScope: "MANAGED",
      state: "OPENED",
      perPage: 1,
    });
    expect(first).toMatchObject({ total: 2, nextPage: 2 });
    expect(first.items.map((request) => request.projectId)).toEqual(["1"]);
    const second = await service.mergeRequests({
      scope: "MINE",
      projectScope: "MANAGED",
      state: "OPENED",
      perPage: 1,
      page: 2,
    });
    expect(second.items.map((request) => request.projectId)).toEqual(["2"]);
    expect(
      read.mock.calls.every(([input]) =>
        /^\/projects\/[12]\/merge_requests$/.test(input.path),
      ),
    ).toBe(true);
  });

  test("deduplicates own MR and checked-out branch pipelines and uses the same relevant set for active counts", async () => {
    const { service, read } = setup();
    vi.mocked(service.projects).mockResolvedValue([
      { id: "1", enabled: true },
    ] as never);
    read.mockImplementation(async ({ path, query }) => {
      let data: unknown[] = [];
      if (path === "/projects/1/merge_requests") {
        expect(query).toMatchObject({ scope: "created_by_me", state: "all" });
        data = [mr(1, 7)];
      } else if (query?.status)
        data =
          query.status === "running"
            ? [pipeline(9, "main"), pipeline(8, "refs/merge-requests/7/head")]
            : [];
      else if (path === "/projects/1/pipelines")
        data = [
          pipeline(9, "main"),
          pipeline(8, "refs/merge-requests/7/head"),
          pipeline(6, "feature", "success"),
        ];
      else if (path.includes("/repository/commits/sha-9/")) data = [mr(1, 7)];
      return { data, headers: new Headers({ "x-next-page": "" }) };
    });
    const page = await service.pipelines("1", 1, 25, { scope: "RELEVANT" });
    expect(page.items.map((item) => item.id)).toEqual(["9", "8", "6"]);
    expect(page.total).toBe(3);
    expect(page.totalIsExact).toBe(true);
    expect(await service.activePipelinesCount()).toBe(2);
    read.mockClear();
    const mine = await service.pipelines("1", 1, 25, {
      scope: "MINE",
      ref: "feature",
    });
    expect(mine.items.map((item) => item.id)).toEqual(["8"]);
    const withoutBranch = await service.pipelines("1", 1, 25, {
      scope: "MINE",
    });
    // A merged MR's commit association does not make its target-branch CI an MR pipeline.
    expect(withoutBranch.items.map((item) => item.id)).toEqual(["8"]);
    expect(read.mock.calls.every(([input]) => input.force !== true)).toBe(true);
  });

  test.each(["MINE", "RELEVANT"] as const)(
    "does not scan pipelines when %s has no own requests or checked-out branches",
    async (scope) => {
      const { service, read } = setup();
      database.codebase.findMany.mockResolvedValue([]);
      expect(await service.pipelines("1", 1, 25, { scope })).toMatchObject({
        items: [],
        total: 0,
        totalIsExact: true,
        nextPage: null,
      });
      expect(read.mock.calls.map(([input]) => input.path)).toEqual([
        "/projects/1/merge_requests",
      ]);
    },
  );

  test.each([403, 404])(
    "retains target MR pipelines when a historical source fork returns %s",
    async (status) => {
      const { service, read } = setup();
      const error = new GitLabRequestError("Fork is unavailable", status);
      const respond = async ({ path }: ReadInput) => {
        if (path === "/projects/2/pipelines") throw error;
        return {
          data:
            path === "/projects/1/merge_requests"
              ? [{ ...mr(1, 7), source_project_id: 2 }]
              : [pipeline(10, "refs/merge-requests/7/head")],
          headers: new Headers({ "x-next-page": "" }),
        };
      };
      read.mockImplementation(respond);
      const result = await service.pipelines("1", 1, 25, { scope: "MINE" });
      expect(result.items.map((item) => item.id)).toEqual(["10"]);
      expect(result.totalIsExact).toBe(true);
      read.mockImplementation(async (input) => {
        if (input.path === "/projects/1/pipelines") throw error;
        return respond(input);
      });
      await expect(
        service.pipelines("1", 1, 25, { scope: "RELEVANT" }),
      ).rejects.toThrow(error);
    },
  );

  test.each([
    ["MINE", 403],
    ["MINE", 404],
    ["RELEVANT", 403],
    ["RELEVANT", 404],
  ] as const)(
    "retains readable fork pipelines for %s when optional target CI returns %s",
    async (scope, status) => {
      const { service, read } = setup();
      database.codebase.findMany.mockResolvedValue([]);
      const own = { ...mr(1, 7), source_project_id: 2 };
      let error: Error = new GitLabRequestError(
        "Target CI is unavailable",
        status,
      );
      read.mockImplementation(async ({ path }) => {
        if (path === "/projects/1/pipelines") throw error;
        return {
          data:
            path === "/projects/2/pipelines"
              ? [{ ...pipeline(10, "feature"), project_id: 2 }]
              : [own],
          headers: new Headers({ "x-next-page": "" }),
        };
      });
      const result = await service.pipelines("1", 1, 25, { scope });
      expect(
        result.items.map((item) => `${item.projectId}:${item.id}`),
      ).toEqual(["2:10"]);
      expect(result).toMatchObject({
        total: 1,
        totalIsExact: true,
        nextPage: null,
      });
      error = new Error("Network connection failed");
      await expect(service.pipelines("1", 1, 25, { scope })).rejects.toThrow(
        error,
      );
    },
  );

  test("retains old branch and fork MR pipelines omitted by commit associations without scanning unrelated MR histories", async () => {
    const { service, read } = setup();
    read.mockImplementation(async ({ path, query }) => {
      let data: unknown[] = [];
      let next = "";
      if (path === "/projects/1/merge_requests")
        data = [
          { ...mr(1, 8), source_project_id: 2, state: "closed" },
          { ...mr(1, 9), source_branch: "another-branch" },
        ];
      else if (path === "/projects/2/pipelines")
        data = [
          { ...pipeline(40, "feature"), project_id: 2 },
          {
            ...pipeline(39, "refs/merge-requests/8/head"),
            project_id: 2,
            source: "merge_request_event",
          },
        ];
      else if (path === "/projects/1/merge_requests/8/pipelines") {
        data =
          query?.page === 1
            ? [pipeline(100, "feature")]
            : [pipeline(40, "feature"), pipeline(39, "feature")];
        next = query?.page === 1 ? "2" : "";
      }
      return { data, headers: new Headers({ "x-next-page": next }) };
    });
    const page = await service.pipelines("1", 1, 25, {
      scope: "MINE",
      ref: "feature",
    });
    expect(page.items.map((item) => `${item.projectId}:${item.id}`)).toEqual([
      "2:40",
      "2:39",
    ]);
    expect(page).toMatchObject({
      total: 2,
      totalIsExact: true,
      nextPage: null,
    });
    expect(
      read.mock.calls.some(([input]) =>
        input.path.includes("/merge_requests/9/pipelines"),
      ),
    ).toBe(false);
    expect(read.mock.calls.every(([input]) => input.force !== true)).toBe(true);
  });

  test("bounds the first pipeline page independently of historical MR count and retains cache reads", async () => {
    const { service, read } = setup();
    read.mockImplementation(async ({ path, query }) => {
      const page = Number(query?.page ?? 1);
      const start = (page - 1) * 100;
      return {
        data: Array.from({ length: 100 }, (_, index) =>
          path.endsWith("/merge_requests")
            ? mr(1, start + index + 1)
            : pipeline(500 - start - index, "refs/merge-requests/1/head"),
        ),
        headers: new Headers({
          "x-next-page": page < 5 ? String(page + 1) : "",
        }),
      };
    });
    const first = await service.pipelines("1", 1, 25, { scope: "MINE" });
    expect(first.items.map((item) => item.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => String(500 - index)),
    );
    expect(first).toMatchObject({
      total: 26,
      totalIsExact: false,
      nextPage: 2,
    });
    expect(read).toHaveBeenCalledTimes(6);
    expect(
      read.mock.calls.filter(
        ([input]) => input.operation === "GitLabScopedPipelines",
      ),
    ).toHaveLength(1);
    expect(read.mock.calls.every(([input]) => input.force !== true)).toBe(true);
    read.mockClear();
    const second = await service.pipelines("1", 2, 25, { scope: "MINE" });
    expect(second.items.map((item) => item.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => String(475 - index)),
    );
    expect(
      read.mock.calls.filter(
        ([input]) => input.operation === "GitLabScopedPipelines",
      ),
    ).toHaveLength(1);
    expect(read.mock.calls.every(([input]) => input.force !== true)).toBe(true);
    const last = await service.pipelines("1", 20, 25, { scope: "MINE" });
    expect(last).toMatchObject({
      total: 500,
      totalIsExact: true,
      nextPage: null,
    });
    expect(last.items.map((item) => item.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => String(25 - index)),
    );
  });

  test("merges sparse target and fork pipeline pages while preserving filters and historical MR membership", async () => {
    const { service, read } = setup();
    const own = [
      mr(1, 7),
      { ...mr(1, 8), source_project_id: 2, state: "closed" },
    ];
    const row = (id: number, ref: string, project = 1) => ({
      ...pipeline(id, ref, "failed"),
      project_id: project,
      source: "merge_request_event",
    });
    read.mockImplementation(async ({ path, query }) => {
      let data: unknown[] = [];
      let next = "";
      if (path === "/projects/1/merge_requests") data = own;
      else if (path.endsWith("/pipelines")) {
        expect(query).toMatchObject({
          order_by: "id",
          sort: "desc",
          status: "failed",
          source: "merge_request_event",
        });
        if (path === "/projects/1/pipelines") {
          data =
            query?.page === 1
              ? [row(12, "someone-else"), row(10, "refs/merge-requests/7/head")]
              : [row(8, "refs/merge-requests/7/merge"), row(6, "someone-else")];
          next = query?.page === 1 ? "2" : "";
        } else
          data = [
            row(11, "feature", 2),
            row(9, "feature", 2),
            row(7, "feature", 2),
          ];
      } else if (path.includes("/repository/commits/sha-")) {
        const id = Number(/sha-(\d+)/.exec(path)![1]);
        data = [11, 9, 7].includes(id) ? [own[1]] : [];
      }
      return { data, headers: new Headers({ "x-next-page": next }) };
    });
    const filters = {
      scope: "MINE" as const,
      ref: "feature",
      status: "FAILED" as const,
      source: "merge_request_event",
    };
    const first = await service.pipelines("1", 1, 2, filters);
    expect(first.items.map((item) => `${item.projectId}:${item.id}`)).toEqual([
      "2:11",
      "1:10",
    ]);
    expect(first).toMatchObject({ total: 3, totalIsExact: false, nextPage: 2 });
    const second = await service.pipelines("1", 2, 2, filters);
    expect(second.items.map((item) => `${item.projectId}:${item.id}`)).toEqual([
      "2:9",
      "1:8",
    ]);
    const last = await service.pipelines("1", 3, 2, filters);
    expect(last.items.map((item) => `${item.projectId}:${item.id}`)).toEqual([
      "2:7",
    ]);
    expect(last).toMatchObject({
      total: 5,
      totalIsExact: true,
      nextPage: null,
    });
    expect(
      read.mock.calls.every(
        ([input]) => !/\/merge_requests\/\d+\/pipelines$/.test(input.path),
      ),
    ).toBe(true);
  });
  test("counts relevant active pipelines beyond100 when provider pagination headers are absent", async () => {
    const { service, read } = setup();
    vi.mocked(service.projects).mockResolvedValue([
      { id: "1", enabled: true },
    ] as never);
    read.mockImplementation(async ({ path, query }) => {
      let data: unknown[] = [];
      if (path.endsWith("/pipelines") && query?.status === "running") {
        data =
          query.page === 1
            ? Array.from({ length: 100 }, (_, id) => pipeline(id, "main"))
            : [pipeline(100, "main"), pipeline(101, "main")];
      }
      return { data, headers: new Headers() };
    });
    expect(await service.activePipelinesCount()).toBe(102);
    expect(
      read.mock.calls
        .filter(([input]) => input.query?.status === "running")
        .map(([input]) => input.query?.page),
    ).toEqual([1, 2]);
  });
});
