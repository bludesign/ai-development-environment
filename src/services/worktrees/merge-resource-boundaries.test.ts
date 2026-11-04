import { beforeEach, describe, expect, test, vi } from "vitest";

const locks = vi.hoisted(() => ({
  reserve: vi.fn(
    async (
      _origin: string,
      _branch: string,
      task: (reservation: {
        markSubmitted(): Promise<void>;
      }) => Promise<unknown>,
    ) => task({ markSubmitted: async () => {} }),
  ),
  local: vi.fn(async () => false),
  recover: vi.fn(async () => {}),
  blocked: vi.fn(async () => null),
}));
vi.mock("@/services/operation-locks/operation-locks.service", () => ({
  withMergeReservation: locks.reserve,
  hasLocalSourceWorktrees: locks.local,
  recoverMergeReservations: locks.recover,
  mergeReservationBlockedReason: locks.blocked,
}));

import { GitHubService } from "@/services/github/github.service";
import { GitLabService } from "@/services/gitlab/gitlab.service";

beforeEach(() => {
  vi.clearAllMocks();
  locks.reserve.mockImplementation(async (_origin, _branch, task) =>
    task({ markSubmitted: async () => {} }),
  );
  locks.local.mockResolvedValue(false);
});

function github() {
  const service = new GitHubService();
  const internal = service as unknown as {
    requireToken(): Promise<string>;
    mergeState(): Promise<unknown>;
    request(): Promise<unknown>;
  };
  vi.spyOn(internal, "requireToken").mockResolvedValue("token");
  const state = {
    viewerPermission: "WRITE",
    availableMethods: ["SQUASH"],
    pullRequest: {
      id: "pr",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefOid: "sha",
      headRefName: "feature",
      headRepository: { nameWithOwner: "Fork/Repo" },
    },
  };
  vi.spyOn(internal, "mergeState").mockResolvedValue(state);
  const submit = vi.spyOn(internal, "request").mockResolvedValue({
    mergePullRequest: { pullRequest: { id: "pr", state: "MERGED" } },
  });
  return { service, submit, state };
}

describe("provider merge resource boundaries", () => {
  test("direct GitHub callers cannot bypass a source build reservation", async () => {
    const f = github();
    locks.reserve.mockRejectedValueOnce(
      new Error("Source worktree is building"),
    );
    await expect(
      f.service.mergePullRequest({
        owner: "team",
        name: "repo",
        number: 1,
        method: "SQUASH",
        commitHeadline: "Merge",
        commitBody: "",
      }),
    ).rejects.toThrow("building");
    expect(locks.reserve).toHaveBeenCalledWith(
      "github.com/fork/repo",
      "feature",
      expect.any(Function),
      { provider: "GITHUB", owner: "team", name: "repo", number: 1 },
    );
    expect(f.submit).not.toHaveBeenCalled();
  });

  test("holds the reservation through the GitHub mutation", async () => {
    const f = github();
    let held = false;
    let submitted = false;
    locks.reserve.mockImplementationOnce(async (_origin, _branch, task) => {
      held = true;
      try {
        return await task({
          markSubmitted: async () => {
            submitted = true;
          },
        });
      } finally {
        held = false;
      }
    });
    f.submit.mockImplementationOnce(async () => {
      expect(held).toBe(true);
      expect(submitted).toBe(true);
      return {
        mergePullRequest: { pullRequest: { id: "pr", state: "MERGED" } },
      };
    });
    await expect(
      f.service.mergePullRequest({
        owner: "team",
        name: "repo",
        number: 1,
        method: "SQUASH",
        commitHeadline: "Merge",
        commitBody: "",
      }),
    ).resolves.toMatchObject({ state: "MERGED" });
    expect(held).toBe(false);
  });

  test("never submits after recovery supersedes a preparing reservation", async () => {
    const f = github();
    locks.reserve.mockImplementationOnce(async (_origin, _branch, task) =>
      task({
        markSubmitted: async () => {
          throw Object.assign(new Error("Reservation superseded"), {
            name: "ResourceBusyError",
          });
        },
      }),
    );
    await expect(
      f.service.mergePullRequest({
        owner: "team",
        name: "repo",
        number: 1,
        method: "SQUASH",
        commitHeadline: "Merge",
        commitBody: "",
      }),
    ).rejects.toMatchObject({ name: "ResourceBusyError" });
    expect(f.submit).not.toHaveBeenCalled();
  });

  test("retains protection when a submitted merge times out and remains unresolved", async () => {
    const f = github();
    f.submit.mockRejectedValueOnce(new Error("network timeout"));
    await expect(
      f.service.mergePullRequest({
        owner: "team",
        name: "repo",
        number: 1,
        method: "SQUASH",
        commitHeadline: "Merge",
        commitBody: "",
      }),
    ).rejects.toMatchObject({ mergeOutcomeUnknown: true });
  });

  test("direct GitLab callers reserve the fork source rather than the target project", async () => {
    const service = new GitLabService();
    vi.spyOn(service, "mergeRequestState").mockResolvedValue({
      sourceProjectId: "fork",
      sourceBranch: "feature",
      state: "OPENED",
      sha: "sha",
    } as never);
    vi.spyOn(service, "mergeProject").mockResolvedValue({
      web_url: "https://gitlab.test/fork/repo",
    } as never);
    const submit = vi.spyOn(
      service as unknown as { mutate(): Promise<unknown> },
      "mutate",
    );
    locks.reserve.mockRejectedValueOnce(
      new Error("Source worktree is building"),
    );
    await expect(
      service.mergeMergeRequestDirect({
        projectId: "target",
        iid: 1,
        sha: "sha",
      }),
    ).rejects.toThrow("building");
    expect(locks.reserve).toHaveBeenCalledWith(
      "gitlab.test/fork/repo",
      "feature",
      expect.any(Function),
      { provider: "GITLAB", projectId: "target", iid: 1 },
    );
    expect(submit).not.toHaveBeenCalled();
  });

  test("does not arm native GitLab automation for a locally protected source", async () => {
    const service = new GitLabService();
    vi.spyOn(service, "mergeRequestState").mockResolvedValue({
      sourceProjectId: "fork",
      sourceBranch: "feature",
      state: "OPENED",
      sha: "sha",
    } as never);
    vi.spyOn(service, "mergeProject").mockResolvedValue({
      web_url: "https://gitlab.test/fork/repo",
    } as never);
    locks.local.mockResolvedValueOnce(true);
    await expect(
      service.mergeMergeRequestDirect({
        projectId: "target",
        iid: 1,
        autoMerge: true,
      }),
    ).rejects.toThrow("managed Auto Merge");
    expect(locks.reserve).not.toHaveBeenCalled();
  });
});
