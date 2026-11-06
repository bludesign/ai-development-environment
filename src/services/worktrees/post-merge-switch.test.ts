import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WORKTREE_POST_MERGE_SWITCH_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";
import type { WorktreesService } from "./worktrees.service";
import type { AgentControlService } from "@/services/agent-control";
import {
  advancePostMergeSwitch,
  getPostMergeSwitchOptions,
  postMergeSwitchView,
  preparePostMergeSwitch,
  retryPostMergeSwitch,
  updatePostMergeSwitchSource,
} from "./post-merge-switch";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

function setup() {
  const worktree = {
    id: "primary",
    codebaseId: "codebase",
    folder: "/repo",
    gitDirectory: "/repo/.git",
    primary: true,
    branch: "feature",
    headSha: "source",
    missingAt: null,
    availability: "AVAILABLE",
    codebase: {
      defaultBranch: "main",
      repository: { canonicalOrigin: "github.com/acme/repo" },
      agent: {
        capabilitiesJson: JSON.stringify([WORKTREE_POST_MERGE_SWITCH_JOB_KIND]),
      },
    },
  };
  const prisma = {
    worktree: {
      findUnique: vi.fn(async () => worktree),
      findUniqueOrThrow: vi.fn(async () => worktree),
    },
  };
  getPrismaClient.mockResolvedValue(prisma);
  const target = {
    origin: "github.com/acme/repo",
    branch: "main",
    sourceBranch: "feature",
    sourceSha: "source",
  };
  const confirmed = { ...target, mergeCommitSha: "squashed" };
  const dispatch = vi.fn(async () => ({ id: "job" }));
  const getJob = vi.fn(async () => ({
    id: "job",
    status: "RUNNING",
    error: null as string | null,
  }));
  const worktrees = {
    postMergeSwitch: dispatch,
  } as unknown as WorktreesService;
  const agents = { getJob } as unknown as AgentControlService;
  return {
    worktree,
    prisma,
    target,
    confirmed,
    dispatch,
    getJob,
    worktrees,
    agents,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("post-merge primary checkout switch", () => {
  test("defaults eligible checkouts on and preserves a saved unchecked selection", async () => {
    const { target } = setup();
    expect(
      await getPostMergeSwitchOptions("primary", target.origin, "main"),
    ).toMatchObject({
      canSwitchToDefaultBranch: true,
      defaultSwitchToDefaultBranch: true,
      switchToDefaultBranchName: "main",
    });
    expect(
      await getPostMergeSwitchOptions("primary", target.origin, "main", null),
    ).toMatchObject({
      canSwitchToDefaultBranch: true,
      defaultSwitchToDefaultBranch: false,
    });
  });

  test.each(["secondary", "unsupported", "fork", "retargeted", "missing"])(
    "explains ineligible checkout: %s",
    async (reason) => {
      const { worktree, target } = setup();
      if (reason === "secondary") worktree.primary = false;
      if (reason === "unsupported")
        worktree.codebase.agent.capabilitiesJson = "[]";
      if (reason === "fork") target.origin = "github.com/fork/repo";
      if (reason === "retargeted") target.branch = "release";
      if (reason === "missing") worktree.availability = "MISSING";
      const options = await getPostMergeSwitchOptions(
        "primary",
        target.origin,
        target.branch,
      );
      expect(options.canSwitchToDefaultBranch).toBe(false);
      expect(options.defaultSwitchToDefaultBranch).toBe(false);
      if (reason !== "secondary")
        expect(options.switchToDefaultBranchUnavailableReason).toBeTruthy();
      else expect(options.switchToDefaultBranchName).toBeNull();
    },
  );

  test("unchecked selection performs no lookup or scheduling", async () => {
    const { target } = setup();
    expect(await preparePostMergeSwitch(null, target, false)).toBeNull();
    expect(getPrismaClient).not.toHaveBeenCalled();
  });

  test("freezes the source and checkout, waits for the job, and records completion", async () => {
    const f = setup();
    let json = (await preparePostMergeSwitch("primary", f.target, true))!;
    const save = vi.fn(async (value: string) => {
      json = value;
    });
    expect(
      await advancePostMergeSwitch(
        json,
        f.confirmed,
        f.worktrees,
        f.agents,
        save,
      ),
    ).toBe(false);
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: "primary",
        expectedHeadSha: "source",
        expectedBranch: "feature",
        branch: "main",
        mergeCommitSha: "squashed",
        folder: "/repo",
      }),
    );
    expect(postMergeSwitchView(json)).toEqual({
      branch: "main",
      state: "UPDATING",
      lastError: null,
    });
    // Projection changes the checked-out branch before coordinator recovery.
    f.worktree.branch = "main";
    f.getJob.mockResolvedValue({ id: "job", status: "SUCCEEDED", error: null });
    expect(
      await advancePostMergeSwitch(
        json,
        f.confirmed,
        f.worktrees,
        f.agents,
        save,
      ),
    ).toBe(true);
    expect(postMergeSwitchView(json)?.state).toBe("COMPLETED");
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(
      await advancePostMergeSwitch(
        json,
        f.confirmed,
        f.worktrees,
        f.agents,
        save,
      ),
    ).toBe(true);
  });

  test("recovery after dispatch reuses the persisted idempotency request", async () => {
    const f = setup();
    const original = (await preparePostMergeSwitch("primary", f.target, true))!;
    const save = vi.fn(async () => {});
    await advancePostMergeSwitch(
      original,
      f.confirmed,
      f.worktrees,
      f.agents,
      save,
    );
    await advancePostMergeSwitch(
      original,
      f.confirmed,
      f.worktrees,
      f.agents,
      save,
    );
    expect(f.dispatch.mock.calls[0]).toEqual(f.dispatch.mock.calls[1]);
  });

  test.each(["origin", "branch", "sourceBranch", "sourceSha"] as const)(
    "rejects changed merge evidence: %s",
    async (field) => {
      const f = setup();
      let json = (await preparePostMergeSwitch("primary", f.target, true))!;
      const save = async (value: string) => {
        json = value;
      };
      await expect(
        advancePostMergeSwitch(
          json,
          { ...f.confirmed, [field]: "changed" },
          f.worktrees,
          f.agents,
          save,
        ),
      ).rejects.toThrow("differs");
      expect(postMergeSwitchView(json)?.state).toBe("ACTION_REQUIRED");
      expect(f.dispatch).not.toHaveBeenCalled();
    },
  );

  test("waits for missing provider evidence, then exposes a retriable warning", async () => {
    vi.useFakeTimers();
    const f = setup();
    let json = (await preparePostMergeSwitch("primary", f.target, true))!;
    const save = async (value: string) => {
      json = value;
    };
    const confirmed = { ...f.confirmed, mergeCommitSha: null };
    expect(
      await advancePostMergeSwitch(
        json,
        confirmed,
        f.worktrees,
        f.agents,
        save,
      ),
    ).toBe(false);
    expect(f.dispatch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120_001);
    await expect(
      advancePostMergeSwitch(json, confirmed, f.worktrees, f.agents, save),
    ).rejects.toThrow("resulting commit");
    json = (await retryPostMergeSwitch(json, f.agents))!;
    expect(
      await advancePostMergeSwitch(
        json,
        f.confirmed,
        f.worktrees,
        f.agents,
        save,
      ),
    ).toBe(false);
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  test("does not schedule a replaced primary checkout", async () => {
    const f = setup();
    const json = (await preparePostMergeSwitch("primary", f.target, true))!;
    f.worktree.gitDirectory = "/different/.git";
    await expect(
      advancePostMergeSwitch(
        json,
        f.confirmed,
        f.worktrees,
        f.agents,
        async () => {},
      ),
    ).rejects.toThrow("checkout or its default branch changed");
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  test("retries only a failed job and retains successful work", async () => {
    const f = setup();
    let json = (await preparePostMergeSwitch("primary", f.target, true))!;
    const save = async (value: string) => {
      json = value;
    };
    f.getJob.mockResolvedValue({
      id: "job",
      status: "FAILED",
      error: "Local changes",
    });
    await expect(
      advancePostMergeSwitch(json, f.confirmed, f.worktrees, f.agents, save),
    ).rejects.toThrow("Local changes");
    const oldRequest = JSON.parse(json).requestId;
    json = (await retryPostMergeSwitch(json, f.agents))!;
    expect(JSON.parse(json)).toMatchObject({
      jobId: null,
      mergeCommitSha: "squashed",
      expectedHeadSha: "source",
      lastError: null,
    });
    expect(JSON.parse(json).requestId).not.toBe(oldRequest);
    f.getJob.mockResolvedValue({ id: "job", status: "SUCCEEDED", error: null });
    expect(
      await advancePostMergeSwitch(
        json,
        f.confirmed,
        f.worktrees,
        f.agents,
        save,
      ),
    ).toBe(true);
    expect(await retryPostMergeSwitch(json, f.agents)).toBe(json);
  });

  test("accepts only managed sync updates before confirmation", async () => {
    const f = setup();
    let json = (await preparePostMergeSwitch("primary", f.target, true))!;
    json = updatePostMergeSwitchSource(json, "synced")!;
    expect(JSON.parse(json).expectedHeadSha).toBe("synced");
    await advancePostMergeSwitch(
      json,
      { ...f.confirmed, sourceSha: "synced" },
      f.worktrees,
      f.agents,
      async (value) => {
        json = value;
      },
    );
    expect(
      JSON.parse(updatePostMergeSwitchSource(json, "unreviewed")!)
        .expectedHeadSha,
    ).toBe("synced");
  });
});
