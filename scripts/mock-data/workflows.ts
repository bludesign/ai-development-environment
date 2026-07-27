import type { PrismaClient } from "../../src/generated/prisma/client";

import { displayNumbers, ids } from "./ids";
import { daysAgo, hoursAgo, minutesAgo } from "./time";

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
    data: { id: "default", nextValue: displayNumbers.workflowRuns.latest + 1 },
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
}
