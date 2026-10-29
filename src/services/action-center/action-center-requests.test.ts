// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import type { PollingService } from "@/services/polling";
import {
  agentEventBus,
  GITHUB_PIPELINE_STATUS_CHANGED_TOPIC,
  INTEGRATION_CONFIGURATION_CHANGED_TOPIC,
} from "@/services/agent-control";
import { AsyncEventBus } from "@/services/agent-control/event-bus";
import {
  ActionCenterRequests,
  actionCenterMergeReady,
} from "./action-center-requests";

const { getPrismaClient } = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

const now = new Date().toISOString();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const request = (id: string, extra = {}) => ({
  id,
  number: 42,
  title: id,
  state: "OPEN",
  repositoryGithubId: "repo",
  repositoryNameWithOwner: "acme/app",
  headRefName: "feature",
  headRefOid: "sha",
  url: "https://github.com/acme/app/pull/42",
  isDraft: false,
  pipelineStatus: "SUCCESS",
  pipelines: [],
  reviewDecision: "APPROVED",
  createdAt: now,
  updatedAt: now,
  worktreeId: null,
  ...extra,
});

describe("Action Center request discovery", () => {
  let prisma: PrismaClient;
  let github: ReturnType<typeof githubStub>;
  let gitlab: ReturnType<typeof gitlabStub>;
  function githubStub() {
    const singleState = vi.fn().mockResolvedValue({
      viewerHasApproved: false,
      canMerge: true,
      mergeBlockedReason: null,
    });
    return {
      actionCenterRequestStates: vi.fn(
        async (prs: Array<{ id: string }>) =>
          new Map(
            await Promise.all(
              prs.map(async (pr) => [pr.id, await singleState()] as const),
            ),
          ),
      ),
      actionCenterIdentity: vi.fn().mockResolvedValue("alice"),
      pullRequests: vi.fn().mockImplementation(
        async (
          scope: string,
          _repository: string | null = null,
          _options: {
            createdAfter?: string | null;
            reviewedByViewer?: boolean;
          } = {},
        ) => ({
          items: scope === "MINE" ? [request("mine")] : [request("review")],
          hasNextPage: false,
          endCursor: null,
        }),
      ),
      actionCenterRequestState: singleState,
    };
  }
  function gitlabStub() {
    return {
      getSettings: vi.fn().mockResolvedValue({
        configured: true,
        baseUrl: "https://gitlab.example",
        viewer: { id: "1" },
      }),
      mergeRequests: vi.fn().mockResolvedValue({ items: [], nextPage: null }),
      mergeReadiness: vi.fn().mockResolvedValue({
        mr: { state: "OPENED", sha: "sha", detailedMergeStatus: "mergeable" },
        canMerge: true,
      }),
      actionCenterApproval: vi.fn().mockResolvedValue(false),
    };
  }
  const polling = {
    register: vi.fn(),
    schedule: vi.fn(),
    run: (_id: string, fn: () => Promise<boolean>) => fn(),
  } as unknown as PollingService;
  const service = () =>
    new ActionCenterRequests(
      github as unknown as GitHubService,
      gitlab as unknown as GitLabService,
      polling,
    );
  beforeEach(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
    });
    const migration = await readFile(
      "prisma/migrations/20261027010000_action_center_requests/migration.sql",
      "utf8",
    );
    for (const sql of migration.split(";").filter((sql) => sql.trim()))
      await prisma.$executeRawUnsafe(sql);
    getPrismaClient.mockResolvedValue(prisma);
    github = githubStub();
    gitlab = gitlabStub();
  });
  afterEach(async () => {
    if (vi.isFakeTimers()) vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await prisma.$disconnect();
  });

  test("keeps GitHub search cutoffs stable while enforcing the exact age boundary locally", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    github.pullRequests.mockResolvedValue({
      items: [
        request("old", { createdAt: "2026-09-29T11:59:59Z" }),
        request("included", { createdAt: "2026-09-29T12:00:00Z" }),
      ],
      hasNextPage: false,
      endCursor: null,
    });
    const index = service();
    await index.refresh(["GITHUB"]);
    expect(
      (await prisma.actionCenterRequest.findMany()).map(
        (row) => JSON.parse(row.payloadJson).id,
      ),
    ).toEqual(["included"]);
    expect(github.actionCenterRequestStates).toHaveBeenCalledOnce();
    expect(github.actionCenterRequestStates.mock.calls[0][0]).toHaveLength(1);
    const firstCutoff = github.pullRequests.mock.calls[0][2].createdAfter;
    vi.setSystemTime(new Date("2026-10-29T12:01:00Z"));
    await index.refresh(["GITHUB"]);
    expect(github.pullRequests.mock.calls.at(-1)![2].createdAfter).toBe(
      firstCutoff,
    );
    expect(firstCutoff).toBe("2026-09-29T00:00:00.000Z");
    expect(await prisma.actionCenterRequest.count()).toBe(0);
    expect(gitlab.getSettings).not.toHaveBeenCalled();
  });

  test("applies pipeline observations locally without scanning either provider", async () => {
    const index = service();
    await index.refresh();
    github.pullRequests.mockClear();
    github.actionCenterRequestStates.mockClear();
    gitlab.mergeRequests.mockClear();
    await (
      index as unknown as { applyGitHubPipeline(event: unknown): Promise<void> }
    ).applyGitHubPipeline({
      githubPipelineStatusChanged: {
        snapshot: {
          repositoryGithubId: "repo",
          headSha: "sha",
          pipelineStatus: "PENDING",
          pipelines: [],
        },
      },
    });
    const rows = await prisma.actionCenterRequest.findMany();
    expect(
      rows.every(
        (row) =>
          JSON.parse(row.payloadJson).request.pipelineStatus === "PENDING",
      ),
    ).toBe(true);
    expect(
      rows.every((row) => !JSON.parse(row.payloadJson).request.canMerge),
    ).toBe(true);
    expect(github.pullRequests).not.toHaveBeenCalled();
    expect(github.actionCenterRequestStates).not.toHaveBeenCalled();
    expect(gitlab.mergeRequests).not.toHaveBeenCalled();
  });

  test("closes known GitHub requests locally and fences stale discovery results", async () => {
    const index = service();
    await index.refresh(["GITHUB"]);
    await (
      index as unknown as { applyGitHubRequest(event: unknown): Promise<void> }
    ).applyGitHubRequest({
      repositoryName: "acme/app",
      number: 42,
      action: "closed",
      event: "pull_request",
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(await prisma.actionCenterRequest.count()).toBe(0);
    await index.refresh(["GITHUB"]);
    expect(await prisma.actionCenterRequest.count()).toBe(0);
  });

  test("exposes account keys only after initial reconciliation", async () => {
    const index = service();
    expect(index.currentAccountKey("GITHUB")).toBeUndefined();
    expect(index.currentAccountKey("GITLAB")).toBeUndefined();

    await index.refresh();

    expect(index.currentAccountKey("GITHUB")).toBe("alice");
    expect(index.currentAccountKey("GITLAB")).toBe("https://gitlab.example:1");
  });

  test("preserves a reconciled account when identity refresh fails", async () => {
    const index = service();
    await index.refresh();
    github.actionCenterIdentity.mockRejectedValueOnce(
      new Error("GitHub offline"),
    );
    gitlab.getSettings.mockRejectedValueOnce(new Error("GitLab offline"));

    await index.refresh();

    expect(index.currentAccountKey("GITHUB")).toBe("alice");
    expect(index.currentAccountKey("GITLAB")).toBe("https://gitlab.example:1");
    expect(index.getWarnings().join()).toContain("GitHub offline");
    expect(index.getWarnings().join()).toContain("GitLab offline");
  });

  test("replaces account keys after reconciling a changed identity", async () => {
    const index = service();
    await index.refresh();
    github.actionCenterIdentity.mockResolvedValue("bob");
    gitlab.getSettings.mockResolvedValue({
      configured: true,
      baseUrl: "https://another.gitlab.example",
      viewer: { id: "2" },
    });

    await index.refresh();

    expect(index.currentAccountKey("GITHUB")).toBe("bob");
    expect(index.currentAccountKey("GITLAB")).toBe(
      "https://another.gitlab.example:2",
    );
    expect(
      await prisma.actionCenterRequest.count({
        where: { provider: "GITHUB", accountKey: { not: "bob" } },
      }),
    ).toBe(0);
  });

  test.each(["GITHUB", "GITLAB"] as const)(
    "does not restore %s account keys from an identity resolved before invalidation",
    async (provider) => {
      const index = service();
      await index.refresh();
      const started = deferred<void>();
      const released = deferred<void>();
      if (provider === "GITHUB")
        github.actionCenterIdentity.mockImplementationOnce(async () => {
          started.resolve();
          await released.promise;
          return "alice";
        });
      else
        gitlab.getSettings.mockImplementationOnce(async () => {
          started.resolve();
          await released.promise;
          return {
            configured: true,
            baseUrl: "https://gitlab.example",
            viewer: { id: "1" },
          };
        });

      const scan = index.refresh();
      await started.promise;
      index.invalidateAccount(provider);
      expect(index.currentAccountKey(provider)).toBeUndefined();
      released.resolve();
      await scan;
      expect(index.currentAccountKey(provider)).toBeUndefined();

      await index.refresh();
      expect(index.currentAccountKey(provider)).toBe(
        provider === "GITHUB" ? "alice" : "https://gitlab.example:1",
      );
    },
  );

  test("does not publish an account key when configuration changes during discovery", async () => {
    const index = service();
    await index.refresh();
    const started = deferred<void>();
    const released = deferred<void>();
    github.pullRequests.mockImplementationOnce(async () => {
      started.resolve();
      await released.promise;
      return {
        items: [request("old-account")],
        hasNextPage: false,
        endCursor: null,
      };
    });

    const scan = index.refresh();
    await started.promise;
    index.invalidateAccount("GITHUB");
    released.resolve();
    await scan;

    expect(index.currentAccountKey("GITHUB")).toBeUndefined();
    expect(index.currentAccountKey("GITLAB")).toBe("https://gitlab.example:1");
  });

  test("provider mutation events preserve known accounts when the connection is unchanged", async () => {
    vi.useFakeTimers();
    const events = new AsyncEventBus();
    vi.spyOn(agentEventBus, "iterate").mockImplementation((topic) =>
      events.iterate(topic),
    );
    const index = service();
    await index.refresh();
    index.start();

    events.publish(GITHUB_PIPELINE_STATUS_CHANGED_TOPIC, {});
    await Promise.resolve();
    expect(index.currentAccountKey("GITHUB")).toBe("alice");
    expect(index.currentAccountKey("GITLAB")).toBe("https://gitlab.example:1");

    events.publish(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, {
      integrationConfigurationChanged: "github",
    });
    await Promise.resolve();
    expect(index.currentAccountKey("GITHUB")).toBe("alice");
    expect(index.currentAccountKey("GITLAB")).toBe("https://gitlab.example:1");

    await index.refresh();
    events.publish(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, {
      integrationConfigurationChanged: "all",
    });
    await Promise.resolve();
    expect(index.currentAccountKey("GITHUB")).toBe("alice");
    expect(index.currentAccountKey("GITLAB")).toBe("https://gitlab.example:1");
  });

  test("deduplicates categories and retains my approved requests", async () => {
    github.pullRequests.mockResolvedValue({
      items: [request("both")],
      hasNextPage: false,
      endCursor: null,
    });
    github.actionCenterRequestState.mockResolvedValue({
      viewerHasApproved: true,
      canMerge: true,
      mergeBlockedReason: null,
    });
    await service().refresh();
    const rows = await prisma.actionCenterRequest.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      isMine: true,
      requiresMyApproval: false,
      reason: "READY_TO_MERGE",
    });
  });
  test("restores a dismissed approval and removes closed requests after complete discovery", async () => {
    const index = service();
    github.actionCenterRequestState.mockResolvedValue({
      viewerHasApproved: true,
      canMerge: true,
      mergeBlockedReason: null,
    });
    await index.refresh();
    expect(
      await prisma.actionCenterRequest.findFirst({ where: { isMine: false } }),
    ).toMatchObject({ requiresMyApproval: false });
    github.actionCenterRequestState.mockResolvedValue({
      viewerHasApproved: false,
      canMerge: true,
      mergeBlockedReason: null,
    });
    await index.refresh();
    expect(
      await prisma.actionCenterRequest.findFirst({ where: { isMine: false } }),
    ).toMatchObject({ requiresMyApproval: true, reason: "REVIEW_REQUIRED" });
    github.pullRequests.mockResolvedValue({
      items: [],
      hasNextPage: false,
      endCursor: null,
    });
    await index.refresh();
    expect(await prisma.actionCenterRequest.count()).toBe(0);
  });
  test("paginates discovery, excludes old requests, and preserves rows on partial failure", async () => {
    let afterCalls = 0;
    github.pullRequests.mockImplementation(async (_scope, _repo, options) => {
      if (options?.after) {
        afterCalls++;
        return {
          items: [request("second")],
          hasNextPage: false,
          endCursor: null,
        };
      }
      return {
        items: [
          request("first"),
          request("old", { createdAt: "2020-01-01T00:00:00Z" }),
        ],
        hasNextPage: true,
        endCursor: "next",
      };
    });
    const index = service();
    await index.refresh();
    expect(afterCalls).toBe(3);
    expect(await prisma.actionCenterRequest.count()).toBe(2);
    github.pullRequests.mockRejectedValue(new Error("Provider offline"));
    await index.refresh();
    expect(await prisma.actionCenterRequest.count()).toBe(2);
    expect(index.getWarnings().join()).toContain("Provider offline");
  });
  test("restores a dismissed GitHub approval after the explicit review request was removed", async () => {
    github.pullRequests.mockImplementation(async (_scope, _repo, options) => ({
      items: options?.reviewedByViewer ? [request("dismissed")] : [],
      hasNextPage: false,
      endCursor: null,
    }));
    github.actionCenterRequestState.mockResolvedValue({
      viewerHasApproved: false,
      viewerReviewState: "DISMISSED",
      canMerge: false,
      mergeBlockedReason: null,
    });
    await service().refresh();
    expect(await prisma.actionCenterRequest.findFirst()).toMatchObject({
      isMine: false,
      requiresMyApproval: true,
      reason: "REVIEW_REQUIRED",
    });
  });

  test("clears another account and disconnected provider records", async () => {
    const index = service();
    await index.refresh();
    github.actionCenterIdentity.mockResolvedValue(null);
    gitlab.getSettings.mockResolvedValue({
      configured: false,
      baseUrl: "https://gitlab.example",
      viewer: { id: "1" },
    });
    await index.refresh();
    expect(await prisma.actionCenterRequest.count()).toBe(0);
    expect(index.currentAccountKey("GITHUB")).toBeNull();
    expect(index.currentAccountKey("GITLAB")).toBeNull();
  });
  test("filters GitLab personal approval independently of overall approval", async () => {
    gitlab.mergeRequests.mockResolvedValue({
      items: [
        {
          id: "7",
          iid: 7,
          projectId: "2",
          title: "MR",
          state: "OPENED",
          sha: "sha",
          sourceBranch: "feature",
          webUrl: "https://gitlab.example/x/y/-/merge_requests/7",
          createdAt: now,
          updatedAt: now,
          approvalState: "REVIEW_REQUIRED",
        },
      ],
      nextPage: null,
    });
    gitlab.actionCenterApproval.mockResolvedValue(true);
    await service().refresh();
    expect(
      await prisma.actionCenterRequest.findFirst({
        where: { provider: "GITLAB" },
      }),
    ).toMatchObject({ isMine: true, requiresMyApproval: false });
    gitlab.actionCenterApproval.mockResolvedValue(false);
    await service().refresh();
    expect(
      await prisma.actionCenterRequest.findFirst({
        where: { provider: "GITLAB" },
      }),
    ).toMatchObject({ requiresMyApproval: true });
  });
});

describe("merge readiness", () => {
  test.each([
    "PENDING",
    "IN_PROGRESS",
    "FAILED",
    "FAILURE",
    "ERROR",
    "UNKNOWN",
  ])("never marks a %s pipeline ready", (pipeline) => {
    expect(actionCenterMergeReady(true, pipeline, "APPROVED")).toBe(false);
  });
  test.each(["REVIEW_REQUIRED", "CHANGES_REQUESTED", "UNKNOWN"])(
    "never marks %s approval ready",
    (approval) => {
      expect(actionCenterMergeReady(true, "SUCCESS", approval)).toBe(false);
    },
  );
  test("requires provider permission and a non-draft request", () => {
    expect(actionCenterMergeReady(false, "SUCCESS", "APPROVED")).toBe(false);
    expect(actionCenterMergeReady(true, "SUCCESS", "APPROVED", true)).toBe(
      false,
    );
    expect(actionCenterMergeReady(true, "SUCCESS", "APPROVED")).toBe(true);
    expect(actionCenterMergeReady(true, "NONE", "NOT_REQUIRED")).toBe(true);
  });
});
