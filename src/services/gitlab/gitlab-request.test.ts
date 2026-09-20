import { beforeEach, expect, test, vi } from "vitest";

const cache = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
}));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({ gitLabRestCacheEntry: cache }),
}));

import { GitLabService } from "./gitlab.service";
import type { GitLabPipelineView } from "./types";

type ResponseView = {
  data: unknown;
  status: number;
  headers: Headers;
  endpoint: string;
  rateLimit: { limit: null; remaining: null; resetAt: null; requestId: null };
};
type RequestInput = {
  path: string;
  operation: string;
  source: "PIPELINES_PAGE";
  force?: boolean;
  allowStaleOnError?: boolean;
};
type ServiceInternals = {
  get(input: RequestInput): Promise<ResponseView>;
  connection(): Promise<{ baseUrl: string; token: string }>;
  ttl(operation: string): Promise<number>;
  fetchRaw(input: unknown): Promise<ResponseView>;
  logCall(input: unknown): Promise<void>;
  recordRateLimit(input: unknown): Promise<void>;
  clearCache(): Promise<boolean>;
  enrichPipelines(
    projectId: string,
    pipelines: GitLabPipelineView[],
  ): Promise<GitLabPipelineView[]>;
  pipelineMergeRequests(projectId: string, sha: string): Promise<[]>;
  pipelineWorktrees(): Promise<
    Map<string, { id: string; highlightColor: string | null }>
  >;
};
const request: RequestInput = {
  path: "/projects/1/pipelines",
  operation: "GitLabPipelines",
  source: "PIPELINES_PAGE",
};
const response = (data: unknown = [{ id: 1 }]): ResponseView => ({
  data,
  status: 200,
  headers: new Headers({ "x-next-page": "2" }),
  endpoint: "https://gitlab.example/api/v4/projects/1/pipelines",
  rateLimit: { limit: null, remaining: null, resetAt: null, requestId: null },
});
function service() {
  const instance = new GitLabService() as unknown as ServiceInternals;
  vi.spyOn(instance, "connection").mockResolvedValue({
    baseUrl: "https://gitlab.example",
    token: "test-token",
  });
  vi.spyOn(instance, "ttl").mockResolvedValue(0);
  vi.spyOn(instance, "logCall").mockResolvedValue();
  vi.spyOn(instance, "recordRateLimit").mockResolvedValue();
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.findUnique.mockResolvedValue(null);
  cache.upsert.mockResolvedValue({});
  cache.deleteMany.mockResolvedValue({ count: 0 });
});

test("coalesces concurrent cache misses, preserves page headers, and does not cache settled promises", async () => {
  const instance = service();
  const gate = Promise.withResolvers<ResponseView>();
  const upstream = vi
    .spyOn(instance, "fetchRaw")
    .mockReturnValueOnce(gate.promise)
    .mockResolvedValue(response());
  const first = instance.get(request);
  const second = instance.get(request);
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
  gate.resolve(response());
  const values = await Promise.all([first, second]);
  expect(values.map((value) => value.headers.get("x-next-page"))).toEqual([
    "2",
    "2",
  ]);
  expect(cache.upsert).toHaveBeenCalledOnce();
  expect(instance.logCall).toHaveBeenCalledOnce();
  await instance.get(request);
  expect(upstream).toHaveBeenCalledTimes(2);
});

test("separates credential scopes and prevents invalidated replies from repopulating cache", async () => {
  const instance = service();
  const gates = Array.from({ length: 3 }, () =>
    Promise.withResolvers<ResponseView>(),
  );
  const upstream = vi
    .spyOn(instance, "fetchRaw")
    .mockImplementationOnce(() => gates[0].promise)
    .mockImplementationOnce(() => gates[1].promise)
    .mockImplementationOnce(() => gates[2].promise);
  const first = instance.get(request);
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
  vi.mocked(instance.connection).mockResolvedValue({
    baseUrl: "https://gitlab.example",
    token: "replacement-test-token",
  });
  const second = instance.get(request);
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2));
  await instance.clearCache();
  const third = instance.get(request);
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(3));
  gates[0].resolve(response([{ id: "old-credential" }]));
  gates[1].resolve(response([{ id: "before-invalidation" }]));
  await Promise.all([first, second]);
  expect(cache.upsert).not.toHaveBeenCalled();
  const fourth = instance.get(request);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(upstream).toHaveBeenCalledTimes(3);
  gates[2].resolve(response([{ id: "current" }]));
  await Promise.all([third, fourth]);
  expect(cache.upsert).toHaveBeenCalledOnce();
  expect(cache.upsert.mock.calls[0][0].create.responseJson).toBe(
    '[{"id":"current"}]',
  );
});

test("preserves each caller's stale-on-error policy and retries failed flights", async () => {
  cache.findUnique.mockResolvedValue({
    fetchedAt: new Date(0),
    responseJson: '[{"id":"stale"}]',
    responseHeadersJson: '{"x-next-page":"3"}',
  });
  const instance = service();
  const gate = Promise.withResolvers<ResponseView>();
  const upstream = vi
    .spyOn(instance, "fetchRaw")
    .mockReturnValueOnce(gate.promise)
    .mockResolvedValue(response());
  const outcomes = Promise.allSettled([
    instance.get(request),
    instance.get({ ...request, allowStaleOnError: false }),
  ]);
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
  gate.reject(new Error("upstream unavailable"));
  const [stale, strict] = await outcomes;
  expect(stale).toMatchObject({
    status: "fulfilled",
    value: { data: [{ id: "stale" }] },
  });
  expect(strict).toMatchObject({
    status: "rejected",
    reason: new Error("upstream unavailable"),
  });
  expect(instance.logCall).toHaveBeenCalledWith(
    expect.objectContaining({ servedStale: true }),
  );
  await instance.get(request);
  expect(upstream).toHaveBeenCalledTimes(2);
});

test("keeps valid cache hits local and lets forced reads refresh upstream", async () => {
  cache.findUnique.mockResolvedValue({
    fetchedAt: new Date(),
    responseJson: '[{"id":"cached"}]',
    responseHeadersJson: '{"x-next-page":"3"}',
  });
  const instance = service();
  vi.mocked(instance.ttl).mockResolvedValue(60);
  const upstream = vi.spyOn(instance, "fetchRaw").mockResolvedValue(response());
  expect((await instance.get(request)).data).toEqual([{ id: "cached" }]);
  expect(upstream).not.toHaveBeenCalled();
  expect((await instance.get({ ...request, force: true })).data).toEqual([
    { id: 1 },
  ]);
  expect(upstream).toHaveBeenCalledOnce();
});

test("deduplicates GitLab enrichment SHAs and caps parallel associations while preserving order", async () => {
  const instance = service();
  const gates = new Map(
    Array.from({ length: 7 }, (_, index) => [
      `sha-${index}`,
      Promise.withResolvers<[]>(),
    ]),
  );
  let active = 0;
  let peak = 0;
  const associations = vi
    .spyOn(instance, "pipelineMergeRequests")
    .mockImplementation(async (_projectId, sha) => {
      peak = Math.max(peak, ++active);
      const value = await gates.get(sha)!.promise;
      active -= 1;
      return value;
    });
  vi.spyOn(instance, "pipelineWorktrees").mockResolvedValue(new Map());
  const pipelines = [...gates.keys(), "sha-0"].map((sha, index) => ({
    id: String(index),
    sha,
    ref: "main",
    source: "push",
  })) as GitLabPipelineView[];
  const result = instance.enrichPipelines("1", pipelines);
  expect(associations).toHaveBeenCalledTimes(4);
  for (const gate of gates.values()) gate.resolve([]);
  expect((await result).map((pipeline) => pipeline.id)).toEqual(
    pipelines.map((pipeline) => pipeline.id),
  );
  expect(associations).toHaveBeenCalledTimes(7);
  expect(peak).toBe(4);
});
