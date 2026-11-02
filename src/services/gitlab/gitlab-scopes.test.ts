import { afterEach, describe, expect, test, vi } from "vitest";
import { GitLabService } from "./gitlab.service";
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
      else if (path.endsWith("/merge_requests/7/pipelines"))
        data = [pipeline(8, "refs/merge-requests/7/head")];
      else if (query?.ref === "feature")
        data = [
          pipeline(8, "refs/merge-requests/7/head"),
          pipeline(6, "feature", "success"),
        ];
      else if (query?.ref === "main") data = [pipeline(9, "main")];
      return { data, headers: new Headers({ "x-next-page": "" }) };
    });
    const page = await service.pipelines("1", 1, 25, { scope: "RELEVANT" });
    expect(page.items.map((item) => item.id)).toEqual(["9", "8", "6"]);
    expect(page.total).toBe(3);
    expect(await service.activePipelinesCount()).toBe(2);
    read.mockClear();
    const mine = await service.pipelines("1", 1, 25, {
      scope: "MINE",
      ref: "feature",
    });
    expect(mine.items.map((item) => item.id)).toEqual(["8"]);
    expect(
      read.mock.calls.every(
        ([input]) => input.path !== "/projects/1/pipelines",
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
