import { afterEach, describe, expect, test, vi } from "vitest";

import { GitLabService } from "./gitlab.service";

type Read = {
  path: string;
  operation: string;
  source: string;
  query: { status: string; page: number; per_page: number };
  force: boolean;
  allowStaleOnError: boolean;
};
type Response = { data: unknown[]; headers: Headers };

function setup(configured = true, projectIds = ["project/1", "2"]) {
  const service = new GitLabService();
  vi.spyOn(service, "getSettings").mockResolvedValue({
    configured,
  } as Awaited<ReturnType<GitLabService["getSettings"]>>);
  vi.spyOn(service, "projects").mockResolvedValue(
    projectIds.map((id) => ({ id })) as Awaited<
      ReturnType<GitLabService["projects"]>
    >,
  );
  const read = vi
    .spyOn(service as unknown as { get(input: Read): Promise<Response> }, "get")
    .mockResolvedValue({ data: [], headers: new Headers({ "x-total": "0" }) });
  return { service, read };
}

afterEach(() => vi.restoreAllMocks());

describe("GitLab active pipeline counts", () => {
  test("sums active status totals across all managed projects without enrichment", async () => {
    const { service, read } = setup();
    const totals: Record<string, number> = {
      created: 2,
      waiting_for_resource: 3,
      waiting_for_callback: 4,
      preparing: 5,
      pending: 6,
      running: 137,
      canceling: 7,
    };
    let running = 0;
    let maximumRunning = 0;
    read.mockImplementation(async (input) => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 0));
      running -= 1;
      expect(input.path).toMatch(/^\/projects\/(project%2F1|2)\/pipelines$/);
      expect(input).toMatchObject({
        operation: "GitLabPipelines",
        source: "PIPELINES_PAGE",
        force: true,
        allowStaleOnError: false,
        query: { page: 1, per_page: 1 },
      });
      expect(totals).toHaveProperty(input.query.status);
      return {
        data: [],
        headers: new Headers({ "x-total": String(totals[input.query.status]) }),
      };
    });

    expect(await service.activePipelinesCount()).toBe(328);
    expect(read).toHaveBeenCalledTimes(14);
    expect(maximumRunning).toBeLessThanOrEqual(4);
  });

  test.each([false, true])(
    "returns zero without provider reads when configured=%s and no projects",
    async (configured) => {
      const { service, read } = setup(configured, []);
      expect(await service.activePipelinesCount()).toBe(0);
      expect(read).not.toHaveBeenCalled();
    },
  );

  test("paginates full pages when total headers are absent", async () => {
    const { service, read } = setup(true, ["1"]);
    read.mockImplementation(async ({ query }) => {
      if (query.status !== "running")
        return { data: [], headers: new Headers({ "x-total": "0" }) };
      if (query.per_page === 1)
        return {
          data: [{ id: 1 }],
          headers: new Headers({ "x-next-page": "2" }),
        };
      if (query.page === 1)
        return {
          data: Array.from({ length: 100 }, (_, id) => ({ id })),
          headers: new Headers({ "x-next-page": "2" }),
        };
      return {
        data: [{ id: 101 }, { id: 102 }],
        headers: new Headers({ "x-next-page": "" }),
      };
    });

    expect(await service.activePipelinesCount()).toBe(102);
    expect(
      read.mock.calls
        .filter(([input]) => input.query.status === "running")
        .map(([input]) => input.query),
    ).toEqual([
      { status: "running", page: 1, per_page: 1 },
      { status: "running", page: 1, per_page: 100 },
      { status: "running", page: 2, per_page: 100 },
    ]);
  });

  test("continues past a full page when every pagination header is absent", async () => {
    const { service, read } = setup(true, ["1"]);
    read.mockImplementation(async ({ query }) => {
      if (query.status !== "pending")
        return { data: [], headers: new Headers({ "x-total": "0" }) };
      return {
        data:
          query.per_page === 1
            ? [{ id: 1 }]
            : query.page === 1
              ? Array.from({ length: 100 }, (_, id) => ({ id }))
              : [],
        headers: new Headers(),
      };
    });
    expect(await service.activePipelinesCount()).toBe(100);
    expect(read.mock.calls).toContainEqual([
      expect.objectContaining({
        query: { status: "pending", page: 2, per_page: 100 },
      }),
    ]);
  });

  test("rejects invalid pagination instead of returning an incomplete total", async () => {
    const { service, read } = setup(true, ["1"]);
    read.mockImplementation(async ({ query }) => ({
      data: [{ id: 1 }],
      headers: new Headers({ "x-next-page": query.per_page === 1 ? "2" : "1" }),
    }));
    await expect(service.activePipelinesCount()).rejects.toThrow(
      "invalid pipeline pagination cursor",
    );
  });

  test("rejects failed status reads instead of reporting a partial count", async () => {
    const { service, read } = setup();
    read.mockImplementation(async ({ query }) => {
      if (query.status === "running") throw new Error("GitLab unavailable");
      return { data: [], headers: new Headers({ "x-total": "4" }) };
    });
    await expect(service.activePipelinesCount()).rejects.toThrow(
      "GitLab unavailable",
    );
  });
});
