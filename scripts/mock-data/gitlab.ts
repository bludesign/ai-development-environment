import { createHash } from "node:crypto";

import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysFromNow, minutesAgo } from "./time";

const BASE_URL = "https://gitlab.acme.example.com/gitlab";
const PROJECT_ID = ids.gitlab.projectId;
const PROJECT_PATH = "acme/platform";
const REPOSITORY_ID = "repo-acme-gitlab-platform";
const CODEBASE_ID = "codebase-acme-gitlab-platform";
const WORKTREE_ID = ids.worktrees.gitlabRetry;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        canonicalize((value as Record<string, unknown>)[key]),
      ]),
  );
}

function cacheKey(
  operation: string,
  path: string,
  query: Record<string, string | number | boolean>,
): string {
  const entries = Object.entries(query)
    .map(([key, value]) => [key, String(value)] as const)
    .toSorted(
      ([firstKey, firstValue], [secondKey, secondValue]) =>
        firstKey.localeCompare(secondKey) ||
        firstValue.localeCompare(secondValue),
    );
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          instance: createHash("sha256").update(BASE_URL).digest("hex"),
          operation,
          path,
          query: entries,
        }),
      ),
    )
    .digest("hex");
}

const user = {
  id: 27,
  username: "jane-doe",
  name: "Jane Doe",
  avatar_url: null,
  web_url: `${BASE_URL}/jane-doe`,
};

const mergeRequests = [
  {
    id: 8101,
    iid: ids.gitlab.mergeRequestIid,
    project_id: Number(PROJECT_ID),
    title: "Improve pipeline retry diagnostics",
    description:
      "Adds structured retry history and makes failed jobs easier to inspect.",
    state: "opened",
    draft: false,
    web_url: `${BASE_URL}/${PROJECT_PATH}/-/merge_requests/42`,
    source_branch: "feature/retry-diagnostics",
    target_branch: "main",
    sha: "5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
    author: user,
    reviewers: [
      {
        id: 31,
        username: "alex-reviewer",
        name: "Alex Reviewer",
        avatar_url: null,
        web_url: `${BASE_URL}/alex-reviewer`,
      },
    ],
    labels: ["backend", "ci"],
    detailed_merge_status: "mergeable",
    merge_when_pipeline_succeeds: false,
    squash_on_merge: true,
    has_conflicts: false,
    blocking_discussions_resolved: true,
    changes_count: "7",
    created_at: minutesAgo(240).toISOString(),
    updated_at: minutesAgo(12).toISOString(),
    merged_at: null,
  },
  {
    id: 8102,
    iid: 41,
    project_id: Number(PROJECT_ID),
    title: "Document the release pipeline",
    description: "Documents deployment gates for maintainers.",
    state: "opened",
    draft: true,
    web_url: `${BASE_URL}/${PROJECT_PATH}/-/merge_requests/41`,
    source_branch: "docs/release-pipeline",
    target_branch: "main",
    sha: "6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192",
    author: user,
    reviewers: [],
    labels: ["documentation"],
    detailed_merge_status: "checking",
    merge_when_pipeline_succeeds: false,
    squash_on_merge: false,
    has_conflicts: false,
    blocking_discussions_resolved: true,
    changes_count: "3",
    created_at: minutesAgo(360).toISOString(),
    updated_at: minutesAgo(35).toISOString(),
    merged_at: null,
  },
];

const pipelines = [
  {
    id: 9401,
    iid: 118,
    project_id: Number(PROJECT_ID),
    ref: "feature/retry-diagnostics",
    sha: mergeRequests[0]!.sha,
    source: "merge_request_event",
    status: "failed",
    web_url: `${BASE_URL}/${PROJECT_PATH}/-/pipelines/9401`,
    created_at: minutesAgo(18).toISOString(),
    started_at: minutesAgo(17).toISOString(),
    updated_at: minutesAgo(8).toISOString(),
    finished_at: minutesAgo(8).toISOString(),
    duration: 301,
    queued_duration: 4,
  },
  {
    id: 9399,
    iid: 117,
    project_id: Number(PROJECT_ID),
    ref: "main",
    sha: "708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3",
    source: "push",
    status: "success",
    web_url: `${BASE_URL}/${PROJECT_PATH}/-/pipelines/9399`,
    created_at: minutesAgo(52).toISOString(),
    started_at: minutesAgo(51).toISOString(),
    updated_at: minutesAgo(45).toISOString(),
    finished_at: minutesAgo(45).toISOString(),
    duration: 416,
    queued_duration: 7,
  },
];

/** Mirrors the prefix GitLabService.mergeRequest() builds, so the cache keys line up. */
const mergeRequestPath = `/projects/${encodeURIComponent(PROJECT_ID)}/merge_requests/${mergeRequests[0]!.iid}`;

const reviewer = mergeRequests[0]!.reviewers[0]!;

/** Only the length is read (`commitsCount`), but the shape mirrors GitLab's commit payload. */
const mergeRequestCommits = [
  {
    id: mergeRequests[0]!.sha,
    short_id: mergeRequests[0]!.sha.slice(0, 8),
    title: "Record retry attempts on the pipeline snapshot",
    author_name: user.name,
    created_at: minutesAgo(230).toISOString(),
  },
  {
    id: "4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70",
    short_id: "4d5e6f70",
    title: "Surface failed job logs in the retry summary",
    author_name: user.name,
    created_at: minutesAgo(200).toISOString(),
  },
  {
    id: "3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f",
    short_id: "3c4d5e6f",
    title: "Add retry history to the pipeline API response",
    author_name: user.name,
    created_at: minutesAgo(180).toISOString(),
  },
  {
    id: "2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
    short_id: "2b3c4d5e",
    title: "Extract the retry policy into its own module",
    author_name: user.name,
    created_at: minutesAgo(165).toISOString(),
  },
];

const mergeRequestDiscussions = [
  {
    id: "d1f0a9b8c7d6e5f40312a9b8c7d6e5f403122a9b",
    individual_note: false,
    notes: [
      {
        id: 71001,
        body: "Retrying here can race with the webhook that marks the pipeline failed. Can we guard on the attempt counter before dispatching?",
        author: reviewer,
        created_at: minutesAgo(96).toISOString(),
        updated_at: minutesAgo(96).toISOString(),
        system: false,
        resolvable: true,
        resolved: false,
        resolved_by: null,
      },
      {
        id: 71002,
        body: "Good catch — the retry now checks `attempts < maxAttempts` inside the same transaction that records the attempt.",
        author: user,
        created_at: minutesAgo(74).toISOString(),
        updated_at: minutesAgo(74).toISOString(),
        system: false,
        resolvable: true,
        resolved: false,
        resolved_by: null,
      },
    ],
  },
  {
    id: "b8c7d6e5f40312a9b8c7d6e5f403122a9b8c7d6e",
    individual_note: false,
    notes: [
      {
        id: 71003,
        body: "The diagnostics payload should include the queued duration so slow runners are distinguishable from failing ones.",
        author: reviewer,
        created_at: minutesAgo(88).toISOString(),
        updated_at: minutesAgo(88).toISOString(),
        system: false,
        resolvable: true,
        resolved: true,
        resolved_by: user,
      },
    ],
  },
  {
    id: "c7d6e5f40312a9b8c7d6e5f403122a9b8c7d6e5f",
    individual_note: true,
    notes: [
      {
        id: 71004,
        body: "Ready for another look — the pipeline failure is the flaky integration job, not this change.",
        author: user,
        created_at: minutesAgo(20).toISOString(),
        updated_at: minutesAgo(20).toISOString(),
        system: false,
        resolvable: false,
        resolved: false,
        resolved_by: null,
      },
    ],
  },
];

function cacheEntry(input: {
  id: string;
  operation: string;
  path: string;
  query: Record<string, string | number | boolean>;
  response: unknown;
}) {
  const request = { path: input.path, query: input.query };
  return {
    id: input.id,
    cacheKey: cacheKey(input.operation, input.path, input.query),
    endpoint: `${BASE_URL}/api/v4${input.path}`,
    operation: input.operation,
    requestJson: JSON.stringify(request),
    responseJson: JSON.stringify(input.response),
    fetchedAt: minutesAgo(2),
  };
}

export async function seedGitLab(prisma: PrismaClient): Promise<void> {
  await prisma.gitLabSettings.create({
    data: {
      id: "default",
      currentUserId: String(user.id),
      currentUsername: user.username,
      currentUserName: user.name,
      currentUserAvatarUrl: user.avatar_url,
      currentUserWebUrl: user.web_url,
      version: "19.2.0",
      revision: "mock-acme",
      verifiedAt: minutesAgo(30),
      pipelinePollIntervalSeconds: 60,
      cacheTtlSeconds: 300,
    },
  });

  await prisma.gitLabProject.create({
    data: {
      id: PROJECT_ID,
      name: "Platform",
      pathWithNamespace: PROJECT_PATH,
      webUrl: `${BASE_URL}/${PROJECT_PATH}`,
      defaultBranch: "main",
      visibility: "private",
      webhookId: "4401",
      webhookState: "CONFIGURED",
      webhookConfiguredAt: minutesAgo(28),
      webhookLastReceivedAt: minutesAgo(8),
    },
  });

  await prisma.codebaseRepository.create({
    data: {
      id: REPOSITORY_ID,
      canonicalOrigin: "gitlab.acme.example.com/gitlab/acme/platform",
      displayOrigin: "gitlab.acme.example.com/gitlab/acme/platform",
      name: "platform",
      description: "Acme platform services hosted in GitLab.",
    },
  });
  await prisma.codebase.create({
    data: {
      id: CODEBASE_ID,
      repositoryId: REPOSITORY_ID,
      agentId: ids.agents.studio,
      folder: "/Users/acme/Repositories/platform",
      observedOrigin: "gitlab.acme.example.com/gitlab/acme/platform",
      branch: "main",
      headSha: pipelines[1]!.sha,
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      syncState: "IN_SYNC",
      availability: "AVAILABLE",
      defaultBranch: "main",
      localBranchesJson: JSON.stringify(["main", "feature/retry-diagnostics"]),
      remoteBranchesJson: JSON.stringify(["main", "feature/retry-diagnostics"]),
      lastCheckedAt: minutesAgo(3),
      lastFetchedAt: minutesAgo(3),
    },
  });
  await prisma.worktree.create({
    data: {
      id: WORKTREE_ID,
      codebaseId: CODEBASE_ID,
      gitDirectory: "/Users/acme/Repositories/platform-retry/.git",
      folder: "/Users/acme/Repositories/platform-retry",
      relativePath: "platform-retry",
      branch: mergeRequests[0]!.source_branch,
      headSha: mergeRequests[0]!.sha,
      upstream: `origin/${mergeRequests[0]!.source_branch}`,
      ahead: 2,
      behind: 0,
      syncState: "AHEAD",
      pushStatus: "READY",
      highlightColor: "violet",
      availability: "AVAILABLE",
      lastCheckedAt: minutesAgo(3),
      pullRequestLookupOrigin: "gitlab.acme.example.com/gitlab/acme/platform",
      pullRequestLookupBranch: mergeRequests[0]!.source_branch,
      pullRequestLookupAt: minutesAgo(3),
    },
  });
  await prisma.worktreeGitLabMergeRequest.create({
    data: {
      worktreeId: WORKTREE_ID,
      gitlabId: String(mergeRequests[0]!.id),
      iid: mergeRequests[0]!.iid,
      projectId: PROJECT_ID,
      title: mergeRequests[0]!.title,
      description: mergeRequests[0]!.description,
      webUrl: mergeRequests[0]!.web_url,
      state: mergeRequests[0]!.state.toUpperCase(),
      draft: mergeRequests[0]!.draft,
      sourceBranch: mergeRequests[0]!.source_branch,
      targetBranch: mergeRequests[0]!.target_branch,
      sha: mergeRequests[0]!.sha,
      authorJson: JSON.stringify({
        id: String(user.id),
        username: user.username,
        name: user.name,
        avatarUrl: user.avatar_url,
        webUrl: user.web_url,
      }),
      reviewersJson: JSON.stringify(
        mergeRequests[0]!.reviewers.map((reviewer) => ({
          id: String(reviewer.id),
          username: reviewer.username,
          name: reviewer.name,
          avatarUrl: reviewer.avatar_url,
          webUrl: reviewer.web_url,
        })),
      ),
      labelsJson: JSON.stringify(mergeRequests[0]!.labels),
      detailedMergeStatus: mergeRequests[0]!.detailed_merge_status,
      mergeWhenPipelineSucceeds: mergeRequests[0]!.merge_when_pipeline_succeeds,
      squashOnMerge: mergeRequests[0]!.squash_on_merge,
      hasConflicts: mergeRequests[0]!.has_conflicts,
      blockingDiscussionsResolved:
        mergeRequests[0]!.blocking_discussions_resolved,
      gitlabCreatedAt: new Date(mergeRequests[0]!.created_at),
      gitlabUpdatedAt: new Date(mergeRequests[0]!.updated_at),
      mergedAt: null,
    },
  });

  await prisma.gitLabRestCacheEntry.createMany({
    data: [
      cacheEntry({
        id: "gitlab-cache-merge-requests-all",
        operation: "GitLabMergeRequests",
        path: "/merge_requests",
        query: {
          scope: "all",
          state: "opened",
          order_by: "updated_at",
          sort: "desc",
          page: 1,
          per_page: 25,
        },
        response: mergeRequests,
      }),
      cacheEntry({
        id: "gitlab-cache-merge-requests-mine",
        operation: "GitLabMergeRequests",
        path: "/merge_requests",
        query: {
          scope: "created_by_me",
          state: "opened",
          order_by: "updated_at",
          sort: "desc",
          page: 1,
          per_page: 25,
        },
        response: mergeRequests,
      }),
      cacheEntry({
        id: "gitlab-cache-merge-requests-review",
        operation: "GitLabMergeRequests",
        path: "/merge_requests",
        query: {
          scope: "reviews_for_me",
          state: "opened",
          order_by: "updated_at",
          sort: "desc",
          page: 1,
          per_page: 25,
        },
        response: [mergeRequests[0]],
      }),
      cacheEntry({
        id: "gitlab-cache-pipelines",
        operation: "GitLabPipelines",
        path: `/projects/${PROJECT_ID}/pipelines`,
        query: {
          page: 1,
          per_page: 25,
          order_by: "id",
          sort: "desc",
        },
        response: pipelines,
      }),
      // The merge request detail page issues these four requests in parallel; all of them must
      // hit the cache or the page renders its error alert, since no GitLab host is reachable.
      cacheEntry({
        id: "gitlab-cache-merge-request-detail",
        operation: "GitLabMergeRequest",
        path: mergeRequestPath,
        query: { include_rebase_in_progress: true },
        response: mergeRequests[0],
      }),
      cacheEntry({
        id: "gitlab-cache-merge-request-commits",
        operation: "GitLabMergeRequestCommits",
        path: `${mergeRequestPath}/commits`,
        query: { per_page: 100 },
        response: mergeRequestCommits,
      }),
      cacheEntry({
        id: "gitlab-cache-merge-request-discussions",
        operation: "GitLabMergeRequestDiscussions",
        path: `${mergeRequestPath}/discussions`,
        query: { per_page: 100 },
        response: mergeRequestDiscussions,
      }),
      cacheEntry({
        id: "gitlab-cache-merge-request-pipelines",
        operation: "GitLabMergeRequestPipelines",
        path: `${mergeRequestPath}/pipelines`,
        query: { per_page: 100 },
        response: [pipelines[0]],
      }),
      ...pipelines.map((pipeline, index) =>
        cacheEntry({
          id: `gitlab-cache-pipeline-merge-requests-${pipeline.id}`,
          operation: "GitLabPipelineMergeRequests",
          path: `/projects/${PROJECT_ID}/repository/commits/${pipeline.sha}/merge_requests`,
          query: { per_page: 100 },
          response: index === 0 ? [mergeRequests[0]] : [],
        }),
      ),
    ],
  });

  await prisma.gitLabPipelineSnapshot.create({
    data: {
      id: "gitlab-pipeline-snapshot-retry",
      projectId: PROJECT_ID,
      headSha: mergeRequests[0]!.sha,
      status: "FAILED",
      lastObservedAt: minutesAgo(8),
      records: {
        create: pipelines.map((pipeline) => ({
          id: `gitlab-pipeline-record-${pipeline.id}`,
          pipelineId: String(pipeline.id),
          ref: pipeline.ref,
          status: pipeline.status.toUpperCase(),
          webUrl: pipeline.web_url,
          source: pipeline.source,
          gitlabUpdatedAt: new Date(pipeline.updated_at),
          lastObservedAt: minutesAgo(8),
        })),
      },
    },
  });

  await prisma.gitLabAutoRetryRule.create({
    data: {
      id: "gitlab-auto-retry-project",
      projectId: PROJECT_ID,
      enabled: true,
      maxAttempts: 2,
      attempts: 1,
      lastAttemptAt: minutesAgo(7),
      executions: {
        create: {
          id: "gitlab-auto-retry-execution-1",
          pipelineId: "9401",
          attempt: 1,
          status: "SUCCEEDED",
        },
      },
    },
  });

  await prisma.gitLabApiCallLog.createMany({
    data: [
      {
        id: "gitlab-api-log-1",
        method: "GET",
        endpoint: `${BASE_URL}/api/v4/merge_requests`,
        operation: "GitLabMergeRequests",
        requestSource: "MERGE_REQUESTS_PAGE",
        requestSummary: '{"scope":"all"}',
        source: "CACHE",
        durationMs: 1,
        statusCode: 200,
        requestId: "acme-gitlab-request-1",
        createdAt: minutesAgo(2),
      },
      {
        id: "gitlab-api-log-2",
        method: "GET",
        endpoint: `${BASE_URL}/api/v4/projects/${PROJECT_ID}/pipelines`,
        operation: "GitLabPipelines",
        requestSource: "PIPELINES_PAGE",
        requestSummary: '{"page":1}',
        source: "LIVE",
        durationMs: 183,
        statusCode: 200,
        rateLimitLimit: 2000,
        rateLimitRemaining: 1987,
        rateLimitResetAt: daysFromNow(0),
        requestId: "acme-gitlab-request-2",
        createdAt: minutesAgo(9),
      },
    ],
  });

  await prisma.gitLabRateLimitSnapshot.create({
    data: {
      id: "gitlab-rate-rest",
      resource: "REST",
      limit: 2000,
      remaining: 1987,
      resetAt: daysFromNow(0),
      observedAt: minutesAgo(9),
    },
  });

  await prisma.gitLabWebhookDelivery.create({
    data: {
      id: "gitlab-webhook-delivery-1",
      webhookId: "acme-gitlab-delivery-1",
      eventType: "Pipeline Hook",
      projectId: PROJECT_ID,
      objectKind: "pipeline",
      action: "failed",
      outcome: "PROCESSED",
      payloadJson: JSON.stringify({
        object_kind: "pipeline",
        project: { id: Number(PROJECT_ID), path_with_namespace: PROJECT_PATH },
      }),
      receivedAt: minutesAgo(8),
      processedAt: minutesAgo(8),
    },
  });
}
