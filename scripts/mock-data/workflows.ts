import type { PrismaClient } from "../../src/generated/prisma/client";

import { displayNumbers, ids } from "./ids";
import { daysAgo, minutesAgo } from "./time";

const definition = {
  format: "aide.workflow",
  schemaVersion: 1,
  name: "PR Review Assistant",
  description: "Loads a pull request and summarizes its review threads.",
  triggers: [
    {
      id: "manual",
      kind: "MANUAL",
      name: "Manual",
      position: { x: 0, y: 140 },
      config: {},
    },
  ],
  nodes: [
    {
      id: "loadPr",
      kind: "GITHUB_LOAD_PR",
      name: "Load Pull Request",
      position: { x: 300, y: 140 },
      config: {},
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
      failurePolicy: "FAIL",
    },
    {
      id: "collectThreads",
      kind: "GITHUB_COLLECT_REVIEW_THREADS",
      name: "Collect Review Threads",
      position: { x: 600, y: 140 },
      config: {},
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
      failurePolicy: "FAIL",
    },
  ],
  edges: [
    {
      id: "edge-1",
      source: "manual",
      target: "loadPr",
      sourceHandle: "success",
      targetHandle: "input",
    },
    {
      id: "edge-2",
      source: "loadPr",
      target: "collectThreads",
      sourceHandle: "success",
      targetHandle: "input",
    },
  ],
  editor: { handleLayout: "SIDES", displayLayout: "REGULAR" },
};

/**
 * Completed runs behind the two detailed ones below. They are numbered *under*
 * `displayNumbers.workflowRuns.latest` because they are older, which keeps the run number and
 * the started column in the same order. Each gets the two step attempts and the three events
 * the definition produces, so the run rows expand into a coherent detail page.
 *
 * None of them is FAILED on purpose: the Action Center index treats every non-archived FAILED
 * WorkflowRun as a "needs attention" item, so a failed row here would add cards to the sidebar
 * that every other screenshot shows. CANCELLED gives the list a non-green row without that.
 */
const WORKFLOW_RUN_HISTORY: Array<{
  repository: "web-app" | "ios-app" | "api";
  prNumber: number;
  status: "SUCCEEDED" | "CANCELLED";
  triggerKind: "MANUAL" | "RESOURCE_MANUAL";
  startedMinutesAgo: number;
  durationMinutes: number;
  error?: string;
}> = [
  {
    repository: "web-app",
    prNumber: 42,
    status: "SUCCEEDED",
    triggerKind: "RESOURCE_MANUAL",
    startedMinutesAgo: 88,
    durationMinutes: 1,
  },
  {
    repository: "api",
    prNumber: 40,
    status: "SUCCEEDED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 132,
    durationMinutes: 2,
  },
  {
    repository: "web-app",
    prNumber: 41,
    status: "SUCCEEDED",
    triggerKind: "RESOURCE_MANUAL",
    startedMinutesAgo: 174,
    durationMinutes: 1,
  },
  {
    repository: "ios-app",
    prNumber: 118,
    status: "CANCELLED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 236,
    durationMinutes: 1,
    error: "Cancelled while loading acme/ios-app#118",
  },
  {
    repository: "ios-app",
    prNumber: 118,
    status: "SUCCEEDED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 249,
    durationMinutes: 2,
  },
  {
    repository: "web-app",
    prNumber: 42,
    status: "SUCCEEDED",
    triggerKind: "RESOURCE_MANUAL",
    startedMinutesAgo: 305,
    durationMinutes: 1,
  },
  {
    repository: "api",
    prNumber: 40,
    status: "CANCELLED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 361,
    durationMinutes: 1,
  },
  {
    repository: "web-app",
    prNumber: 39,
    status: "SUCCEEDED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 60 * 8,
    durationMinutes: 2,
  },
  {
    repository: "web-app",
    prNumber: 41,
    status: "SUCCEEDED",
    triggerKind: "RESOURCE_MANUAL",
    startedMinutesAgo: 60 * 9,
    durationMinutes: 1,
  },
  {
    repository: "api",
    prNumber: 40,
    status: "SUCCEEDED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 60 * 11,
    durationMinutes: 3,
  },
  {
    repository: "web-app",
    prNumber: 42,
    status: "CANCELLED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 60 * 26,
    durationMinutes: 1,
    error: "Cancelled while collecting review threads",
  },
  {
    repository: "ios-app",
    prNumber: 118,
    status: "SUCCEEDED",
    triggerKind: "RESOURCE_MANUAL",
    startedMinutesAgo: 60 * 27,
    durationMinutes: 2,
  },
  {
    repository: "web-app",
    prNumber: 39,
    status: "SUCCEEDED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 60 * 30,
    durationMinutes: 1,
  },
  {
    repository: "api",
    prNumber: 40,
    status: "SUCCEEDED",
    triggerKind: "RESOURCE_MANUAL",
    startedMinutesAgo: 60 * 33,
    durationMinutes: 2,
  },
  {
    repository: "web-app",
    prNumber: 41,
    status: "SUCCEEDED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 60 * 50,
    durationMinutes: 1,
  },
  {
    repository: "web-app",
    prNumber: 42,
    status: "SUCCEEDED",
    triggerKind: "RESOURCE_MANUAL",
    startedMinutesAgo: 60 * 52,
    durationMinutes: 2,
  },
  {
    repository: "ios-app",
    prNumber: 118,
    status: "SUCCEEDED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 60 * 74,
    durationMinutes: 1,
  },
  {
    repository: "web-app",
    prNumber: 39,
    status: "SUCCEEDED",
    triggerKind: "MANUAL",
    startedMinutesAgo: 60 * 76,
    durationMinutes: 2,
  },
];

export async function seedWorkflows(prisma: PrismaClient): Promise<void> {
  const definitionJson = JSON.stringify(definition);

  await prisma.workflow.create({
    data: {
      id: ids.workflows.prReview,
      name: "PR Review Assistant",
      description: "Loads a pull request and summarizes its review threads.",
      draftDefinitionJson: definitionJson,
      draftSchemaVersion: 1,
      enabled: true,
      overlapPolicy: "QUEUE",
      maxConcurrentRuns: 1,
      quickActionKind: "STANDARD",
      quickActionIconKey: "sparkles",
      createdAt: daysAgo(15),
    },
  });

  await prisma.workflowVersion.create({
    data: {
      id: ids.workflowVersions.prReviewV1,
      workflowId: ids.workflows.prReview,
      version: 1,
      name: "PR Review Assistant",
      description: "Loads a pull request and summarizes its review threads.",
      schemaVersion: 1,
      definitionJson,
      contentHash: "sha256-workflow-pr-review-0001",
      publishedAt: daysAgo(15),
      createdAt: daysAgo(15),
    },
  });

  await prisma.workflow.update({
    where: { id: ids.workflows.prReview },
    data: { activeVersionId: ids.workflowVersions.prReviewV1 },
  });

  await prisma.workflowQuickActionRepository.create({
    data: {
      workflowId: ids.workflows.prReview,
      repositoryId: ids.repositories.web,
    },
  });

  await prisma.workflowRunNumberSequence.create({
    data: { id: "default", nextValue: displayNumbers.workflowRuns.running + 1 },
  });

  await prisma.workflowRun.create({
    data: {
      id: ids.workflowRuns.latest,
      displayNumber: displayNumbers.workflowRuns.latest,
      workflowId: ids.workflows.prReview,
      versionId: ids.workflowVersions.prReviewV1,
      idempotencyKey: "workflow-run-latest-key",
      triggerKind: "MANUAL",
      triggerSubjectKey: "manual",
      triggerPayloadJson: JSON.stringify({ pr: { number: 42 } }),
      status: "SUCCEEDED",
      phase: "COMPLETED",
      sessionDataJson: JSON.stringify({
        pr: { number: 42 },
        repo: { displayOrigin: "github.com/acme/web-app" },
      }),
      queuedAt: minutesAgo(35),
      startedAt: minutesAgo(35),
      finishedAt: minutesAgo(34),
      createdAt: minutesAgo(35),
      attempts: {
        create: [
          {
            id: "workflow-attempt-load-pr",
            nodeId: "loadPr",
            kind: "GITHUB_LOAD_PR",
            status: "SUCCEEDED",
            phase: "COMPLETED",
            idempotencyKey: "workflow-attempt-load-pr-key",
            startedAt: minutesAgo(35),
            finishedAt: minutesAgo(35),
          },
          {
            id: "workflow-attempt-collect-threads",
            nodeId: "collectThreads",
            kind: "GITHUB_COLLECT_REVIEW_THREADS",
            status: "SUCCEEDED",
            phase: "COMPLETED",
            idempotencyKey: "workflow-attempt-collect-threads-key",
            startedAt: minutesAgo(35),
            finishedAt: minutesAgo(34),
          },
        ],
      },
      events: {
        create: [
          {
            id: "workflow-event-1",
            sequence: 1,
            type: "RUN_STARTED",
            message: "Workflow run started",
            createdAt: minutesAgo(35),
          },
          {
            id: "workflow-event-2",
            sequence: 2,
            type: "STEP_SUCCEEDED",
            message: "Loaded pull request acme/web-app#42",
            createdAt: minutesAgo(35),
          },
          {
            id: "workflow-event-3",
            sequence: 3,
            type: "RUN_SUCCEEDED",
            message: "Workflow completed successfully",
            createdAt: minutesAgo(34),
          },
        ],
      },
      resourceLinks: {
        create: [
          {
            id: "workflow-resource-link-1",
            kind: "PULL_REQUEST",
            resourceId: "acme/web-app#42",
            label: "acme/web-app#42",
            url: "https://github.com/acme/web-app/pull/42",
          },
        ],
      },
    },
  });

  /**
   * A run still in flight. The Action Center index treats any non-terminal WorkflowRun with no
   * pending questions as reason ACTIVE, which is what makes this its second "active" item; the
   * worktree id in `sessionDataJson` is how that item links back to its worktree.
   */
  await prisma.workflowRun.create({
    data: {
      id: ids.workflowRuns.running,
      displayNumber: displayNumbers.workflowRuns.running,
      workflowId: ids.workflows.prReview,
      versionId: ids.workflowVersions.prReviewV1,
      idempotencyKey: "workflow-run-running-key",
      triggerKind: "MANUAL",
      triggerSubjectKey: "acme/api#58",
      triggerPayloadJson: JSON.stringify({ pr: { number: 58 } }),
      status: "RUNNING",
      phase: "RUNNING",
      sessionDataJson: JSON.stringify({
        pr: { number: 58 },
        repo: { displayOrigin: "github.com/acme/api" },
        worktree: { id: ids.worktrees.apiFeature },
      }),
      queuedAt: minutesAgo(4),
      startedAt: minutesAgo(4),
      createdAt: minutesAgo(4),
      attempts: {
        create: [
          {
            id: "workflow-running-attempt-load-pr",
            nodeId: "loadPr",
            kind: "GITHUB_LOAD_PR",
            status: "SUCCEEDED",
            phase: "COMPLETED",
            idempotencyKey: "workflow-running-attempt-load-pr-key",
            startedAt: minutesAgo(4),
            finishedAt: minutesAgo(4),
          },
          {
            id: "workflow-running-attempt-collect-threads",
            nodeId: "collectThreads",
            kind: "GITHUB_COLLECT_REVIEW_THREADS",
            status: "RUNNING",
            phase: "RUNNING",
            idempotencyKey: "workflow-running-attempt-collect-threads-key",
            startedAt: minutesAgo(3),
          },
        ],
      },
      events: {
        create: [
          {
            id: "workflow-running-event-1",
            sequence: 1,
            type: "RUN_STARTED",
            message: "Workflow run started",
            createdAt: minutesAgo(4),
          },
          {
            id: "workflow-running-event-2",
            sequence: 2,
            type: "STEP_SUCCEEDED",
            message: "Loaded pull request acme/api#58",
            createdAt: minutesAgo(4),
          },
          {
            id: "workflow-running-event-3",
            sequence: 3,
            type: "STEP_STARTED",
            message: "Collecting review threads",
            createdAt: minutesAgo(3),
          },
        ],
      },
      resourceLinks: {
        create: [
          {
            id: "workflow-running-resource-link-1",
            kind: "PULL_REQUEST",
            resourceId: "acme/api#58",
            label: "acme/api#58",
            url: "https://github.com/acme/api/pull/58",
          },
        ],
      },
    },
  });

  for (const [index, run] of WORKFLOW_RUN_HISTORY.entries()) {
    const slug = `history-${index + 1}`;
    // Newest first, counting back from the run just below the latest detailed one, so run
    // numbers and start times stay in the same order.
    const displayNumber = displayNumbers.workflowRuns.latest - 1 - index;
    const subject = `acme/${run.repository}#${run.prNumber}`;
    const startedAt = minutesAgo(run.startedMinutesAgo);
    const finishedAt = minutesAgo(run.startedMinutesAgo - run.durationMinutes);
    const succeeded = run.status === "SUCCEEDED";
    await prisma.workflowRun.create({
      data: {
        id: `workflow-run-${slug}`,
        displayNumber,
        workflowId: ids.workflows.prReview,
        versionId: ids.workflowVersions.prReviewV1,
        idempotencyKey: `workflow-run-${slug}-key`,
        triggerKind: run.triggerKind,
        triggerSubjectKey: subject,
        triggerPayloadJson: JSON.stringify({ pr: { number: run.prNumber } }),
        status: run.status,
        phase: succeeded ? "COMPLETED" : run.status,
        sessionDataJson: JSON.stringify({
          pr: { number: run.prNumber },
          repo: { displayOrigin: `github.com/acme/${run.repository}` },
        }),
        error: run.error ?? null,
        queuedAt: startedAt,
        startedAt,
        finishedAt,
        createdAt: startedAt,
        attempts: {
          create: [
            {
              id: `workflow-attempt-${slug}-load-pr`,
              nodeId: "loadPr",
              kind: "GITHUB_LOAD_PR",
              status: "SUCCEEDED",
              phase: "SUCCEEDED",
              idempotencyKey: `workflow-attempt-${slug}-load-pr-key`,
              startedAt,
              finishedAt,
            },
            {
              id: `workflow-attempt-${slug}-collect-threads`,
              nodeId: "collectThreads",
              kind: "GITHUB_COLLECT_REVIEW_THREADS",
              status: succeeded ? "SUCCEEDED" : run.status,
              phase: succeeded ? "SUCCEEDED" : run.status,
              idempotencyKey: `workflow-attempt-${slug}-collect-threads-key`,
              startedAt,
              finishedAt,
            },
          ],
        },
        events: {
          create: [
            {
              id: `workflow-event-${slug}-1`,
              sequence: 1,
              type: "RUN_STARTED",
              message: "Workflow run started",
              createdAt: startedAt,
            },
            {
              id: `workflow-event-${slug}-2`,
              sequence: 2,
              type: "STEP_SUCCEEDED",
              message: `Loaded pull request ${subject}`,
              createdAt: startedAt,
            },
            {
              id: `workflow-event-${slug}-3`,
              sequence: 3,
              type: succeeded ? "RUN_SUCCEEDED" : "RUN_CANCELLED",
              message:
                run.error ??
                (succeeded
                  ? "Workflow completed successfully"
                  : "Workflow run cancelled"),
              createdAt: finishedAt,
            },
          ],
        },
        resourceLinks: {
          create: [
            {
              id: `workflow-resource-link-${slug}`,
              kind: "PULL_REQUEST",
              resourceId: subject,
              label: subject,
              url: `https://github.com/acme/${run.repository}/pull/${run.prNumber}`,
            },
          ],
        },
      },
    });
  }
}
