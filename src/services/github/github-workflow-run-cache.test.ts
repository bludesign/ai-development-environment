import { afterEach, expect, test, vi } from "vitest";
import { GitHubWorkflowRunCache } from "./github-workflow-run-cache";

afterEach(() => vi.useRealTimers());
const url =
  "https://api.github.com/repos/acme/app/actions/runs?per_page=100&page=1";

test("shares complete list pages across readers for thirty seconds and supports explicit refresh", async () => {
  vi.useFakeTimers();
  const cache = new GitHubWorkflowRunCache();
  const fetcher = vi.fn(async () => ({ total_count: 0, workflow_runs: [] }));
  const first = await cache.read("token", url, fetcher);
  expect((await cache.read("token", url, fetcher)).cached).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce();
  expect((await cache.read("token", url, fetcher)).fetchedAt).toEqual(
    first.fetchedAt,
  );
  await cache.read("token", url, fetcher, true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  await cache.read("token", url, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("isolates credentials, pages and filters", async () => {
  const cache = new GitHubWorkflowRunCache();
  const fetcher = vi.fn(async () => []);
  await cache.read("one", url, fetcher);
  await cache.read("two", url, fetcher);
  await cache.read("one", url + "&branch=main", fetcher);
  await cache.read("one", url.replace("page=1", "page=2"), fetcher);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

test("coalesces flights but never caches a rejected request", async () => {
  const cache = new GitHubWorkflowRunCache();
  const pending = Promise.withResolvers<number>();
  const fetcher = vi.fn(() => pending.promise);
  const first = cache.read("token", url, fetcher);
  const second = cache.read("token", url, fetcher);
  pending.reject(new Error("offline"));
  expect(
    (await Promise.allSettled([first, second])).every(
      (result) => result.status === "rejected",
    ),
  ).toBe(true);
  await cache.read("token", url, async () => 2);
  expect(fetcher).toHaveBeenCalledOnce();
});

test.each(["repository", "all"])(
  "%s invalidation fences old flights without clearing another repository",
  async (mode) => {
    const cache = new GitHubWorkflowRunCache();
    const pending = Promise.withResolvers<number>();
    const old = cache.read("token", url, () => pending.promise);
    const other = url.replace("acme/app", "acme/other");
    await cache.read("token", other, async () => 7);
    if (mode === "repository") cache.invalidateRepository("Acme/App");
    else cache.clear();
    await cache.read("token", url, async () => 2);
    pending.resolve(1);
    await old;
    expect((await cache.read("token", url, async () => 3)).data).toBe(2);
    const otherFetch = vi.fn(async () => 8);
    expect((await cache.read("token", other, otherFetch)).data).toBe(
      mode === "repository" ? 7 : 8,
    );
  },
);
