import { beforeEach, expect, test, vi } from "vitest";
import type { BulkMergeReview } from "@/services/worktrees/bulk-merge-review";
import { GitLabRequestError, GitLabService } from "./gitlab.service";
import type { GitLabMergeRequestView } from "./types";

const mock = vi.hoisted(() => ({ markSubmitted: vi.fn() }));
vi.mock("@/services/operation-locks/operation-locks.service", () => ({
  hasLocalSourceWorktrees: vi.fn().mockResolvedValue(false),
  recoverMergeReservations: vi.fn(),
  withMergeReservation: async (
    _origin: string,
    _branch: string,
    action: (reservation: {
      markSubmitted: typeof mock.markSubmitted;
    }) => Promise<unknown>,
  ) => action(mock),
}));

const review: BulkMergeReview = {
  itemId: "item",
  headSha: "a".repeat(40),
  sourceOrigin: "gitlab.example/team/fork",
  sourceBranch: "feature",
  targetBranch: "main",
  instanceUrl: "https://gitlab.example",
};
const input = { projectId: "21", iid: 42, sha: review.headSha };
const request = {
  state: "OPENED",
  sourceProjectId: "8",
  sourceBranch: review.sourceBranch,
  targetBranch: review.targetBranch,
  sha: review.headSha,
  detailedMergeStatus: "mergeable",
} as GitLabMergeRequestView;

function setup() {
  const service = new GitLabService();
  const state = vi
    .spyOn(service, "mergeRequestState")
    .mockResolvedValue(request);
  vi.spyOn(service, "mergeProject").mockResolvedValue({
    web_url: `https://${review.sourceOrigin}`,
  } as Awaited<ReturnType<GitLabService["mergeProject"]>>);
  const mutate = vi.spyOn(
    service as unknown as {
      mutate(input: Record<string, unknown>): Promise<unknown>;
    },
    "mutate",
  );
  return { service, state, mutate };
}

beforeEach(() => vi.clearAllMocks());

test("rejects a target change before sending a merge", async () => {
  const { service, state, mutate } = setup();
  state
    .mockResolvedValueOnce(request)
    .mockResolvedValueOnce({ ...request, targetBranch: "release" });
  await expect(service.mergeMergeRequestDirect(input, review)).rejects.toThrow(
    "reviewed GitLab source, target or merge readiness changed",
  );
  expect(mock.markSubmitted).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
});

test("uses the reviewed SHA and treats a provider 409 with a new source as stale review", async () => {
  const { service, state, mutate } = setup();
  state
    .mockResolvedValueOnce(request)
    .mockResolvedValueOnce(request)
    .mockResolvedValueOnce({ ...request, sha: "b".repeat(40) });
  mutate.mockRejectedValueOnce(new GitLabRequestError("SHA mismatch", 409));
  await expect(service.mergeMergeRequestDirect(input, review)).rejects.toThrow(
    "reviewed GitLab source or target changed",
  );
  expect(mutate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      expectedBaseUrl: review.instanceUrl,
      body: expect.objectContaining({ sha: review.headSha }),
    }),
  );
});

test("verifies exact review identity when recovering an ambiguous response", async () => {
  const { service, state, mutate } = setup();
  const merged = { ...request, state: "MERGED" };
  state
    .mockResolvedValueOnce(request)
    .mockResolvedValueOnce(request)
    .mockResolvedValueOnce(merged);
  mutate.mockRejectedValueOnce(
    new GitLabRequestError("Could not decode response", 200),
  );
  await expect(service.mergeMergeRequestDirect(input, review)).resolves.toBe(
    merged,
  );

  state
    .mockResolvedValueOnce(request)
    .mockResolvedValueOnce(request)
    .mockResolvedValueOnce({ ...merged, targetBranch: "release" });
  mutate.mockRejectedValueOnce(new Error("Connection lost"));
  await expect(
    service.mergeMergeRequestDirect(input, review),
  ).rejects.toMatchObject({ mergeOutcomeUnknown: true });
  expect(mutate).toHaveBeenCalledTimes(2);
});
