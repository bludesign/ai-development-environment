// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import type { PollingService } from "@/services/polling";
import {
  ActionCenterRequests,
  actionCenterMergeReady,
} from "./action-center-requests";

const { getPrismaClient } = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

const now = new Date().toISOString();
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
    return {
      actionCenterIdentity: vi.fn().mockResolvedValue("alice"),
      pullRequests: vi.fn().mockImplementation(async (scope: string) => ({
        items: scope === "MINE" ? [request("mine")] : [request("review")],
        hasNextPage: false,
        endCursor: null,
      })),
      actionCenterRequestState: vi.fn().mockResolvedValue({
        viewerHasApproved: false,
        canMerge: true,
        mergeBlockedReason: null,
      }),
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
    await prisma.$disconnect();
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
    await index.refresh();
    expect(await prisma.actionCenterRequest.count()).toBe(0);
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
