import { afterEach, expect, test, vi } from "vitest";

import { GitHubService } from "@/services/github";
import { GitLabService } from "@/services/gitlab";

afterEach(() => {
  vi.unstubAllGlobals();
});

type GitHubInternals = {
  reviewerRest(path: string): Promise<unknown>;
  requireToken(): Promise<string>;
  request(
    query: string,
    variables: unknown,
    token: string,
    options: unknown,
  ): Promise<unknown>;
  clearCache(): Promise<boolean>;
  pullRequest(): Promise<unknown>;
};

test("GitHub additive write validates native IDs, sets union, and succeeds if cache refresh fails", async () => {
  const service = new GitHubService();
  const internal = service as unknown as GitHubInternals;
  vi.spyOn(internal, "reviewerRest").mockImplementation(async (path) =>
    path.includes("/pulls/")
      ? { id: 77, node_id: "PR_77", state: "open" }
      : { id: 3, node_id: "USER_3" },
  );
  vi.spyOn(internal, "requireToken").mockResolvedValue("token");
  const request = vi.spyOn(internal, "request").mockResolvedValue({});
  vi.spyOn(internal, "clearCache").mockRejectedValue(
    new Error("Cache unavailable"),
  );
  const detail = vi
    .spyOn(internal, "pullRequest")
    .mockRejectedValue(new Error("Hydration unavailable"));
  await expect(
    service.addPullRequestReviewers({
      owner: "acme",
      name: "project",
      number: 8,
      expectedId: "PR_77",
      reviewers: [{ id: "3", username: "carol" }],
    }),
  ).resolves.toBeUndefined();
  expect(request.mock.calls[0][0]).toContain("union: true");
  expect(request.mock.calls[0][1]).toEqual({
    pullRequestId: "PR_77",
    userIds: ["USER_3"],
  });
  expect(detail).not.toHaveBeenCalled();
});

test("GitHub rejects a login which now belongs to a different user", async () => {
  const service = new GitHubService();
  const internal = service as unknown as GitHubInternals;
  vi.spyOn(internal, "reviewerRest").mockImplementation(async (path) =>
    path.includes("/pulls/")
      ? { id: 77, node_id: "PR_77", state: "open" }
      : { id: 99, node_id: "USER_99" },
  );
  const request = vi.spyOn(internal, "request").mockResolvedValue({});
  await expect(
    service.addPullRequestReviewers({
      owner: "acme",
      name: "project",
      number: 8,
      expectedId: "PR_77",
      reviewers: [{ id: "3", username: "carol" }],
    }),
  ).rejects.toThrow("identity changed");
  expect(request).not.toHaveBeenCalled();
});

type GitLabInternals = {
  get(input: unknown): Promise<{ data: unknown }>;
  mutate(input: unknown): Promise<unknown>;
  connection(): Promise<{ baseUrl: string; token: string }>;
  logCall(input: unknown): Promise<void>;
  recordRateLimit(input: unknown, resource?: string): Promise<void>;
};

test("GitLab fetches fresh state and preserves external reviewers when setting the union", async () => {
  const service = new GitLabService();
  const internal = service as unknown as GitLabInternals;
  const get = vi.spyOn(internal, "get").mockResolvedValue({
    data: { id: 77, state: "opened", reviewers: [{ id: 2 }, { id: 9 }] },
  });
  const mutate = vi.spyOn(internal, "mutate").mockResolvedValue({});
  await service.addMergeRequestReviewers({
    projectId: "10",
    iid: 8,
    expectedId: "77",
    reviewerIds: ["3", "2"],
  });
  expect(get).toHaveBeenCalledWith(
    expect.objectContaining({ force: true, allowStaleOnError: false }),
  );
  expect(mutate).toHaveBeenCalledWith(
    expect.objectContaining({ body: { reviewer_ids: [2, 9, 3] } }),
  );
});

test("GitLab does not change a closed or replaced merge request", async () => {
  const service = new GitLabService();
  const internal = service as unknown as GitLabInternals;
  vi.spyOn(internal, "get").mockResolvedValue({
    data: { id: 77, state: "closed", reviewers: [] },
  });
  const mutate = vi.spyOn(internal, "mutate").mockResolvedValue({});
  await expect(
    service.addMergeRequestReviewers({
      projectId: "10",
      iid: 8,
      expectedId: "77",
      reviewerIds: ["3"],
    }),
  ).rejects.toThrow("no longer open");
  expect(mutate).not.toHaveBeenCalled();
});

test("GitLab ownership GraphQL reads keep credentials private and use bounded fresh requests", async () => {
  const service = new GitLabService();
  const internal = service as unknown as GitLabInternals;
  vi.spyOn(internal, "connection").mockResolvedValue({
    baseUrl: "https://gitlab.example/root",
    token: "private-token",
  });
  const log = vi.spyOn(internal, "logCall").mockResolvedValue();
  vi.spyOn(internal, "recordRateLimit").mockResolvedValue();
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ data: { project: {} } }), { status: 200 }),
    );
  vi.stubGlobal("fetch", fetch);
  await service.reviewerGraphql("query Owners { project { id } }", {
    path: "org/project",
  });
  expect(fetch).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({
      redirect: "manual",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }),
  );
  expect(String(fetch.mock.calls[0][0])).toContain(
    "https://gitlab.example/root/api/graphql?",
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
});
