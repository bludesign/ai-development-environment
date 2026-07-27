import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysFromNow, hoursAgo, minutesAgo } from "./time";

const WEB_GITHUB_ID = "R_kgACMEweb";
const WEB_HEAD_SHA = "5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";

/**
 * Delivery history behind the three deliveries the pipeline snapshot above depends on. Kept as
 * a flat table because the Webhooks page only renders these columns; ids and timestamps are
 * derived from the row order so the list always groups into the same days.
 */
const WEBHOOK_HISTORY: Array<{
  event: string;
  action: string | null;
  repository: "web-app" | "ios-app" | "api";
  outcome: "PROCESSED" | "IGNORED" | "ERROR";
  minutesAgo: number;
  workflowRunId?: string;
  error?: string;
}> = [
  {
    event: "check_run",
    action: "completed",
    repository: "web-app",
    outcome: "PROCESSED",
    minutesAgo: 18,
  },
  {
    event: "pull_request_review",
    action: "submitted",
    repository: "web-app",
    outcome: "PROCESSED",
    minutesAgo: 24,
  },
  {
    event: "workflow_run",
    action: "requested",
    repository: "api",
    outcome: "PROCESSED",
    minutesAgo: 31,
    workflowRunId: "9876543220",
  },
  {
    event: "push",
    action: null,
    repository: "api",
    outcome: "PROCESSED",
    minutesAgo: 33,
  },
  {
    event: "issue_comment",
    action: "created",
    repository: "web-app",
    outcome: "IGNORED",
    minutesAgo: 47,
  },
  {
    event: "workflow_job",
    action: "completed",
    repository: "web-app",
    outcome: "PROCESSED",
    minutesAgo: 58,
    workflowRunId: "9876543211",
  },
  {
    event: "pull_request",
    action: "opened",
    repository: "ios-app",
    outcome: "PROCESSED",
    minutesAgo: 96,
  },
  {
    event: "check_suite",
    action: "requested",
    repository: "ios-app",
    outcome: "PROCESSED",
    minutesAgo: 98,
  },
  {
    event: "installation_repositories",
    action: "added",
    repository: "api",
    outcome: "IGNORED",
    minutesAgo: 142,
  },
  {
    event: "workflow_run",
    action: "completed",
    repository: "api",
    outcome: "ERROR",
    minutesAgo: 168,
    workflowRunId: "9876543218",
    error: "Repository is not linked to a codebase",
  },
  {
    event: "pull_request_review_comment",
    action: "created",
    repository: "web-app",
    outcome: "PROCESSED",
    minutesAgo: 214,
  },
  {
    event: "push",
    action: null,
    repository: "web-app",
    outcome: "PROCESSED",
    minutesAgo: 236,
  },
  {
    event: "status",
    action: null,
    repository: "ios-app",
    outcome: "IGNORED",
    minutesAgo: 305,
  },
  {
    event: "workflow_run",
    action: "completed",
    repository: "ios-app",
    outcome: "PROCESSED",
    minutesAgo: 372,
    workflowRunId: "9876543205",
  },
  {
    event: "pull_request",
    action: "closed",
    repository: "web-app",
    outcome: "PROCESSED",
    minutesAgo: 60 * 26,
  },
  {
    event: "check_run",
    action: "rerequested",
    repository: "web-app",
    outcome: "PROCESSED",
    minutesAgo: 60 * 27,
  },
  {
    event: "ping",
    action: null,
    repository: "api",
    outcome: "IGNORED",
    minutesAgo: 60 * 31,
  },
];

export async function seedGitHub(prisma: PrismaClient): Promise<void> {
  await prisma.gitHubRepository.createMany({
    data: [
      {
        id: "github-repo-web",
        githubId: WEB_GITHUB_ID,
        owner: "acme",
        name: "web-app",
        nameWithOwner: "acme/web-app",
        url: "https://github.com/acme/web-app",
      },
      {
        id: "github-repo-ios",
        githubId: "R_kgACMEios",
        owner: "acme",
        name: "ios-app",
        nameWithOwner: "acme/ios-app",
        url: "https://github.com/acme/ios-app",
      },
      {
        id: "github-repo-api",
        githubId: "R_kgACMEapi",
        owner: "acme",
        name: "api",
        nameWithOwner: "acme/api",
        url: "https://github.com/acme/api",
      },
    ],
  });

  await prisma.gitHubPipelineSnapshot.create({
    data: {
      id: "pipeline-snapshot-web",
      repositoryGithubId: WEB_GITHUB_ID,
      repositoryNameWithOwner: "acme/web-app",
      repositoryUrl: "https://github.com/acme/web-app",
      headSha: WEB_HEAD_SHA,
      pipelineStatus: "FAILURE",
      graphqlRollupStatus: "FAILURE",
      lastObservedAt: minutesAgo(6),
      records: {
        create: [
          {
            id: "pipeline-record-build",
            identityKey: "workflow:build",
            githubPipelineId: "9876543210",
            name: "Build",
            status: "SUCCESS",
            url: "https://github.com/acme/web-app/actions/runs/9876543210",
            workflowRunId: "9876543210",
            workflowId: "build.yml",
            runNumber: 412,
            runAttempt: 1,
            jobsJson: JSON.stringify([
              {
                id: "gh-job-build",
                name: "build",
                status: "SUCCESS",
                canRetry: false,
                steps: [],
              },
            ]),
            source: "WEBHOOK",
            sourceFetchedAt: minutesAgo(6),
            lastObservedAt: minutesAgo(6),
          },
          {
            id: "pipeline-record-test",
            identityKey: "workflow:test",
            githubPipelineId: "9876543211",
            name: "Test",
            status: "FAILURE",
            url: "https://github.com/acme/web-app/actions/runs/9876543211",
            workflowRunId: "9876543211",
            workflowId: "test.yml",
            runNumber: 412,
            runAttempt: 1,
            canRetry: true,
            jobsJson: JSON.stringify([
              {
                id: "gh-job-unit",
                name: "unit",
                status: "FAILURE",
                canRetry: true,
                steps: [],
              },
              {
                id: "gh-job-e2e",
                name: "e2e",
                status: "SUCCESS",
                canRetry: false,
                steps: [],
              },
            ]),
            source: "WEBHOOK",
            sourceFetchedAt: minutesAgo(6),
            lastObservedAt: minutesAgo(6),
          },
          {
            id: "pipeline-record-lint",
            identityKey: "workflow:lint",
            githubPipelineId: "9876543212",
            name: "Lint",
            status: "SUCCESS",
            url: "https://github.com/acme/web-app/actions/runs/9876543212",
            workflowRunId: "9876543212",
            workflowId: "lint.yml",
            runNumber: 412,
            runAttempt: 1,
            jobsJson: JSON.stringify([
              {
                id: "gh-job-eslint",
                name: "eslint",
                status: "SUCCESS",
                canRetry: false,
                steps: [],
              },
            ]),
            source: "WEBHOOK",
            sourceFetchedAt: minutesAgo(6),
            lastObservedAt: minutesAgo(6),
          },
        ],
      },
    },
  });

  await prisma.gitHubWorkflowRunObservation.create({
    data: {
      id: "workflow-run-observation-web-test",
      codebaseRepositoryId: ids.repositories.web,
      workflowRunId: "9876543211",
      runAttempt: 1,
      workflowId: "test.yml",
      status: "COMPLETED",
      conclusion: "FAILURE",
      githubUpdatedAt: minutesAgo(6),
      source: "WEBHOOK",
      lastObservedAt: minutesAgo(6),
    },
  });

  await prisma.gitHubActionsPollingState.create({
    data: {
      codebaseRepositoryId: ids.repositories.web,
      initializedAt: hoursAgo(48),
      lastPollStartedAt: minutesAgo(1),
      lastPollCompletedAt: minutesAgo(1),
      lastPollSucceededAt: minutesAgo(1),
    },
  });

  await prisma.gitHubGraphqlCacheEntry.create({
    data: {
      id: ids.githubCacheEntries.pullRequests,
      cacheKey: "github:acme/web-app:pull-requests",
      authentication: "APP",
      endpoint: "https://api.github.com/graphql",
      operation: "PullRequests",
      query:
        "query PullRequests($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ pullRequests(first:20){ nodes { number title } } } }",
      variablesJson: JSON.stringify({ owner: "acme", name: "web-app" }),
      responseJson: JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 42,
                  title: "Add quick search to the global navigation bar",
                },
              ],
            },
          },
        },
      }),
      pointCost: 1,
      fetchedAt: minutesAgo(4),
    },
  });

  await prisma.gitHubApiCallLog.createMany({
    data: [
      {
        id: "github-api-log-1",
        authentication: "APP",
        operation: "PullRequests",
        source: "LIVE",
        durationMs: 284,
        statusCode: 200,
        pointCost: 1,
        rateLimitLimit: 5000,
        rateLimitRemaining: 4993,
        rateLimitUsed: 7,
        rateLimitResetAt: daysFromNow(0),
        createdAt: minutesAgo(4),
      },
      {
        id: "github-api-log-2",
        authentication: "APP",
        operation: "PullRequests",
        source: "CACHE",
        durationMs: 3,
        servedStale: false,
        pointsAvoided: 1,
        createdAt: minutesAgo(2),
      },
      {
        id: "github-api-log-3",
        authentication: "APP",
        operation: "CheckRuns",
        source: "LIVE",
        durationMs: 331,
        statusCode: 200,
        pointCost: 1,
        createdAt: minutesAgo(6),
      },
    ],
  });

  await prisma.gitHubRateLimitSnapshot.createMany({
    data: [
      {
        id: "github-rate-graphql",
        authentication: "APP",
        resource: "graphql",
        limit: 5000,
        remaining: 4993,
        used: 7,
        resetAt: daysFromNow(0),
        observedAt: minutesAgo(4),
      },
      {
        id: "github-rate-core",
        authentication: "APP",
        resource: "core",
        limit: 15000,
        remaining: 14980,
        used: 20,
        resetAt: daysFromNow(0),
        observedAt: minutesAgo(4),
      },
    ],
  });

  await prisma.gitHubWebhookDelivery.createMany({
    data: [
      {
        deliveryId: "webhook-delivery-1",
        event: "workflow_run",
        action: "completed",
        repositoryName: "acme/web-app",
        workflowRunId: "9876543211",
        outcome: "PROCESSED",
        receivedAt: minutesAgo(6),
        processedAt: minutesAgo(6),
      },
      {
        deliveryId: "webhook-delivery-2",
        event: "check_suite",
        action: "completed",
        repositoryName: "acme/web-app",
        outcome: "PROCESSED",
        receivedAt: minutesAgo(6),
        processedAt: minutesAgo(6),
      },
      {
        deliveryId: "webhook-delivery-3",
        event: "pull_request",
        action: "synchronize",
        repositoryName: "acme/web-app",
        outcome: "IGNORED",
        receivedAt: minutesAgo(12),
        processedAt: minutesAgo(12),
      },
      ...WEBHOOK_HISTORY.map((delivery, index) => ({
        deliveryId: `webhook-delivery-${index + 4}`,
        event: delivery.event,
        action: delivery.action,
        repositoryName: `acme/${delivery.repository}`,
        workflowRunId: delivery.workflowRunId ?? null,
        outcome: delivery.outcome,
        error: delivery.error ?? null,
        receivedAt: minutesAgo(delivery.minutesAgo),
        // Errored deliveries are recorded but never reach the processed state.
        processedAt:
          delivery.outcome === "ERROR" ? null : minutesAgo(delivery.minutesAgo),
      })),
    ],
  });
}
