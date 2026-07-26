import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { GitHubActionsWorkflowRunView } from "./types";

const directory = mkdtempSync(join(tmpdir(), "github-pipeline-status-"));
const databasePath = join(directory, "pipeline.db");
let service: import("./github-pipeline-status.service").GitHubPipelineStatusService;

function run(
  overrides: Partial<GitHubActionsWorkflowRunView> = {},
): GitHubActionsWorkflowRunView {
  return {
    id: "run-1",
    workflowId: "workflow-1",
    repositoryGithubId: "repository-1",
    codebaseRepositoryId: "codebase-repository-1",
    repositoryNameWithOwner: "acme/widgets",
    repositoryUrl: "https://github.com/acme/widgets",
    name: "CI",
    displayTitle: "CI",
    runNumber: 7,
    runAttempt: 1,
    event: "pull_request",
    status: "SUCCESS",
    url: "https://github.com/acme/widgets/actions/runs/1",
    headBranch: "feature/APP-1",
    headSha: "sha-1",
    checkSuiteId: "suite-1",
    canRetry: true,
    retryUnavailableReason: null,
    pullRequests: [],
    jiraKey: "APP-1",
    worktreeId: null,
    worktreeHighlightColor: null,
    startedAt: "2026-07-26T10:00:00.000Z",
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T10:01:00.000Z",
    ...overrides,
  };
}

beforeAll(async () => {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE "GitHubPipelineSnapshot" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "repositoryGithubId" TEXT NOT NULL,
      "repositoryNameWithOwner" TEXT NOT NULL,
      "repositoryUrl" TEXT NOT NULL,
      "headSha" TEXT NOT NULL,
      "pipelineStatus" TEXT NOT NULL,
      "graphqlRollupStatus" TEXT,
      "revision" INTEGER NOT NULL DEFAULT 0,
      "lastGraphqlSyncAt" DATETIME,
      "lastObservedAt" DATETIME NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    );
    CREATE UNIQUE INDEX "GitHubPipelineSnapshot_repositoryGithubId_headSha_key"
      ON "GitHubPipelineSnapshot"("repositoryGithubId", "headSha");
    CREATE TABLE "GitHubPipelineRecord" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "snapshotId" TEXT NOT NULL,
      "identityKey" TEXT NOT NULL,
      "githubPipelineId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "url" TEXT,
      "checkSuiteId" TEXT,
      "workflowRunId" TEXT,
      "workflowId" TEXT,
      "runNumber" INTEGER,
      "runAttempt" INTEGER,
      "canRetry" BOOLEAN NOT NULL DEFAULT false,
      "retryUnavailableReason" TEXT,
      "jobsJson" TEXT NOT NULL DEFAULT '[]',
      "source" TEXT NOT NULL,
      "githubUpdatedAt" DATETIME,
      "sourceFetchedAt" DATETIME NOT NULL,
      "lastObservedAt" DATETIME NOT NULL,
      "optimisticUntil" DATETIME,
      "isCurrent" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("snapshotId") REFERENCES "GitHubPipelineSnapshot"("id") ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX "GitHubPipelineRecord_snapshotId_identityKey_key"
      ON "GitHubPipelineRecord"("snapshotId", "identityKey");
    CREATE INDEX "GitHubPipelineRecord_workflowRunId_idx"
      ON "GitHubPipelineRecord"("workflowRunId");
    CREATE INDEX "GitHubPipelineRecord_checkSuiteId_idx"
      ON "GitHubPipelineRecord"("checkSuiteId");
  `);
  database.close();
  process.env.DATABASE_URL = `file:${databasePath}`;
  delete (globalThis as typeof globalThis & { prismaGlobal?: unknown })
    .prismaGlobal;
  const serviceModule = await import("./github-pipeline-status.service");
  service = new serviceModule.GitHubPipelineStatusService();
});

afterAll(async () => {
  const prisma = (
    globalThis as typeof globalThis & {
      prismaGlobal?: { $disconnect(): Promise<void> };
    }
  ).prismaGlobal;
  await prisma?.$disconnect();
  delete process.env.DATABASE_URL;
  rmSync(directory, { recursive: true, force: true });
});

describe("GitHubPipelineStatusService", () => {
  test("reconciles aliases and preserves jobs across GraphQL observations", async () => {
    await service.observeSnapshot({
      repositoryGithubId: "repository-1",
      repositoryNameWithOwner: "acme/widgets",
      repositoryUrl: "https://github.com/acme/widgets",
      headSha: "sha-1",
      graphqlRollupStatus: "PENDING",
      completeGraphqlRollup: true,
      sourceFetchedAt: new Date("2026-07-26T10:00:00.000Z"),
      pipelines: [
        {
          id: "suite-1",
          name: "CI",
          status: "IN_PROGRESS",
          checkSuiteId: "suite-1",
          source: "GRAPHQL",
          githubUpdatedAt: new Date("2026-07-26T10:00:00.000Z"),
        },
      ],
    });
    await service.observeWorkflowRuns([run()], "REST", true);
    await service.observeJobs(
      "repository-1",
      "run-1",
      [
        {
          id: "job-1",
          name: "test",
          status: "SUCCESS",
          url: null,
          canRetry: true,
          retryUnavailableReason: null,
          runAttempt: 1,
          steps: [{ number: 1, name: "Run tests", status: "SUCCESS" }],
        },
      ],
      "REST",
      new Date("2026-07-26T10:01:00.000Z"),
    );

    await service.observeSnapshot({
      repositoryGithubId: "repository-1",
      repositoryNameWithOwner: "acme/widgets",
      repositoryUrl: "https://github.com/acme/widgets",
      headSha: "sha-1",
      graphqlRollupStatus: "SUCCESS",
      completeGraphqlRollup: true,
      sourceFetchedAt: new Date("2026-07-26T10:02:00.000Z"),
      pipelines: [
        {
          id: "suite-1",
          name: "CI",
          status: "SUCCESS",
          checkSuiteId: "suite-1",
          workflowRunId: "run-1",
          runAttempt: 1,
          source: "GRAPHQL",
          sourceFetchedAt: new Date("2026-07-26T10:02:00.000Z"),
          githubUpdatedAt: new Date("2026-07-26T10:02:00.000Z"),
        },
      ],
    });

    const records = await service.records([
      { repositoryGithubId: "repository-1", workflowRunId: "run-1" },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      checkSuiteId: "suite-1",
      workflowRunId: "run-1",
      jobs: [expect.objectContaining({ id: "job-1" })],
    });
    expect(
      await service.snapshot({
        repositoryGithubId: "repository-1",
        headSha: "sha-1",
      }),
    ).toMatchObject({
      pipelineStatus: "SUCCESS",
      pipelines: [{ id: "suite-1" }],
    });
  });

  test("does not let cached GraphQL regress newer REST and clears jobs for a new attempt", async () => {
    await service.observeSnapshot({
      repositoryGithubId: "repository-1",
      repositoryNameWithOwner: "acme/widgets",
      repositoryUrl: "https://github.com/acme/widgets",
      headSha: "sha-1",
      graphqlRollupStatus: "FAILURE",
      completeGraphqlRollup: true,
      sourceFetchedAt: new Date("2026-07-26T09:00:00.000Z"),
      pipelines: [
        {
          id: "suite-1",
          name: "CI",
          status: "FAILURE",
          checkSuiteId: "suite-1",
          source: "GRAPHQL",
          githubUpdatedAt: new Date("2026-07-26T09:00:00.000Z"),
        },
      ],
    });
    expect(
      await service.snapshot({
        repositoryGithubId: "repository-1",
        headSha: "sha-1",
      }),
    ).toMatchObject({ pipelineStatus: "SUCCESS" });

    await service.observeWorkflowRuns(
      [
        run({
          runAttempt: 2,
          status: "IN_PROGRESS",
          updatedAt: "2026-07-26T10:03:00.000Z",
        }),
      ],
      "REST",
      true,
    );
    const record = (
      await service.records([
        { repositoryGithubId: "repository-1", workflowRunId: "run-1" },
      ])
    )[0]!;
    expect(record.runAttempt).toBe(2);
    expect(record.jobs).toEqual([]);
  });

  test("keeps Actions history out of current membership and merges webhook jobs", async () => {
    await service.observeWorkflowRuns(
      [run({ id: "historical-run", headSha: "sha-history" })],
      "REST",
      false,
    );
    expect(
      await service.snapshot({
        repositoryGithubId: "repository-1",
        headSha: "sha-history",
      }),
    ).toMatchObject({ pipelineStatus: "NONE", pipelines: [] });

    await service.observeWorkflowRuns(
      [run({ id: "webhook-run", headSha: "sha-webhook" })],
      "WEBHOOK",
      true,
    );
    for (const [id, name] of [
      ["job-a", "test"],
      ["job-b", "lint"],
    ]) {
      await service.observeJobs(
        "repository-1",
        "webhook-run",
        [
          {
            id,
            name,
            status: "SUCCESS",
            url: null,
            canRetry: true,
            retryUnavailableReason: null,
            runAttempt: 1,
            steps: [],
          },
        ],
        "WEBHOOK",
        new Date("2026-07-26T10:01:00.000Z"),
      );
    }
    const [record] = await service.records([
      { repositoryGithubId: "repository-1", workflowRunId: "webhook-run" },
    ]);
    expect(record?.jobs.map(({ id }) => id).sort()).toEqual(["job-a", "job-b"]);
  });

  test("increments revisions only for user-visible changes", async () => {
    const input = {
      repositoryGithubId: "repository-1",
      repositoryNameWithOwner: "acme/widgets",
      repositoryUrl: "https://github.com/acme/widgets",
      headSha: "sha-stable",
      sourceFetchedAt: new Date("2026-07-26T10:00:00.000Z"),
      pipelines: [
        {
          id: "deploy",
          name: "deploy",
          status: "SUCCESS" as const,
          statusContext: "deploy",
          source: "REST" as const,
          githubUpdatedAt: new Date("2026-07-26T10:00:00.000Z"),
        },
      ],
    };
    const first = await service.observeSnapshot(input);
    const second = await service.observeSnapshot(input);
    expect(first.snapshot.revision).toBe(1);
    expect(second.snapshot.revision).toBe(1);
  });

  test("publishes the first empty GraphQL rollup", async () => {
    const input = {
      repositoryGithubId: "repository-1",
      repositoryNameWithOwner: "acme/widgets",
      repositoryUrl: "https://github.com/acme/widgets",
      headSha: "sha-expected",
      graphqlRollupStatus: "EXPECTED" as const,
      completeGraphqlRollup: true,
      sourceFetchedAt: new Date("2026-07-26T10:00:00.000Z"),
      pipelines: [],
    };

    const first = await service.observeSnapshot(input);
    const second = await service.observeSnapshot(input);

    expect(first.snapshot).toMatchObject({
      pipelineStatus: "EXPECTED",
      pipelines: [],
      revision: 1,
    });
    expect(second.snapshot.revision).toBe(1);
  });
});
