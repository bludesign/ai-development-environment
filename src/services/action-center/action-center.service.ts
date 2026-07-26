import "server-only";

import { randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  SIDEBAR_STATUS_CHANGED_TOPIC,
} from "@/services/agent-control";
import { getSessionValue } from "@/lib/workflows/session";

const ACTIVE_RUN_STATUSES = ["IN_PROGRESS", "PAUSED"];
const ACTIVE_BUILD_STATUSES = ["QUEUED", "PREPARING", "RUNNING"];
const ACTIVE_WORKFLOW_STATUSES = [
  "QUEUED",
  "RUNNING",
  "PAUSING",
  "PAUSED",
  "WAITING",
  "BLOCKED",
];
const RESOURCE_KINDS = ["PLAN", "SESSION", "BUILD", "WORKFLOW"] as const;

export type ActionCenterResourceKind = (typeof RESOURCE_KINDS)[number];
export type ActionCenterReason =
  "QUESTION" | "BLOCKED" | "FAILED" | "UNRUN_BUILD" | "ACTIVE";

export type ActionCenterQuestionBatchView = {
  id: string;
  sourceKind: string | null;
  createdAt: string;
  questions: Array<{
    id: string;
    position: number;
    header: string | null;
    prompt: string;
    multiSelect: boolean;
    allowCustom: boolean;
    options: Array<{
      id: string;
      position: number;
      label: string;
      description: string | null;
    }>;
  }>;
};

export type ActionCenterItemView = {
  key: string;
  resourceKind: ActionCenterResourceKind;
  reason: ActionCenterReason;
  resourceId: string;
  href: string;
  displayNumber: number | null;
  label: string;
  summary: string | null;
  status: string;
  phase: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  worktree: {
    id: string;
    folder: string;
    branch: string | null;
    highlightColor: string | null;
  } | null;
  questionBatches: ActionCenterQuestionBatchView[];
  buildRun: {
    buildId: string;
    destinationType: string;
    preferredDestination: unknown;
  } | null;
  failureFingerprint: string | null;
};

type ActionCenterCursor = {
  priority: number;
  updatedAt: string;
  key: string;
};

type AcknowledgeInput = {
  resourceKind: string;
  resourceId: string;
  failureFingerprint: string;
};

const questionInclude = {
  questions: {
    orderBy: { position: "asc" as const },
    include: { options: { orderBy: { position: "asc" as const } } },
  },
} as const;

function iso(value: Date): string {
  return value.toISOString();
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function runHref(kind: string, id: string): string {
  return `/${kind === "PLAN" ? "plans" : "sessions"}/${encodeURIComponent(id)}`;
}

function workflowHref(id: string): string {
  return `/workflows/runs/${encodeURIComponent(id)}`;
}

function buildHref(id: string): string {
  return `/builds/${encodeURIComponent(id)}`;
}

function failureFingerprint(
  kind: ActionCenterResourceKind,
  id: string,
  timestamp: Date,
  generation?: number,
): string {
  return [kind, id, generation ?? 0, timestamp.toISOString()].join(":");
}

function priority(reason: ActionCenterReason): number {
  switch (reason) {
    case "QUESTION":
      return 0;
    case "BLOCKED":
      return 1;
    case "FAILED":
      return 2;
    case "UNRUN_BUILD":
      return 3;
    case "ACTIVE":
      return 4;
  }
}

function compareItems(
  first: ActionCenterItemView,
  second: ActionCenterItemView,
): number {
  const byPriority = priority(first.reason) - priority(second.reason);
  if (byPriority) return byPriority;
  const byUpdatedAt = second.updatedAt.localeCompare(first.updatedAt);
  return byUpdatedAt || first.key.localeCompare(second.key);
}

function encodeCursor(item: ActionCenterItemView): string {
  return Buffer.from(
    JSON.stringify({
      priority: priority(item.reason),
      updatedAt: item.updatedAt,
      key: item.key,
    } satisfies ActionCenterCursor),
  ).toString("base64url");
}

function decodeCursor(
  value: string | null | undefined,
): ActionCenterCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ActionCenterCursor>;
    if (
      typeof parsed.priority !== "number" ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.key !== "string"
    ) {
      return null;
    }
    return parsed as ActionCenterCursor;
  } catch {
    return null;
  }
}

function afterCursor(item: ActionCenterItemView, cursor: ActionCenterCursor) {
  const itemPriority = priority(item.reason);
  if (itemPriority !== cursor.priority) return itemPriority > cursor.priority;
  if (item.updatedAt !== cursor.updatedAt)
    return item.updatedAt < cursor.updatedAt;
  return item.key > cursor.key;
}

function mapQuestionBatch(
  batch: {
    id: string;
    createdAt: Date;
    questions: Array<{
      id: string;
      position: number;
      header: string | null;
      prompt: string;
      multiSelect: boolean;
      allowCustom: boolean;
      options: Array<{
        id: string;
        position: number;
        label: string;
        description: string | null;
      }>;
    }>;
  },
  sourceKind: string | null,
): ActionCenterQuestionBatchView {
  return {
    id: batch.id,
    sourceKind,
    createdAt: iso(batch.createdAt),
    questions: batch.questions,
  };
}

function compactPrompt(value: string, maximum = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1)}…`
    : normalized;
}

function buildTargetKey(build: {
  id: string;
  worktreeId: string | null;
  configurationId: string | null;
  destinationType: string;
}): string {
  return build.worktreeId && build.configurationId
    ? [build.worktreeId, build.configurationId, build.destinationType].join(":")
    : build.id;
}

function workflowWorktreeId(sessionDataJson: string): string | null {
  const value = getSessionValue(parseJson(sessionDataJson), "worktree.id");
  return typeof value === "string" && value ? value : null;
}

export class ActionCenterService {
  async list(input: { first?: number | null; after?: string | null } = {}) {
    const prisma = await getPrismaClient();
    const first = Math.max(1, Math.min(input.first ?? 50, 200));
    const [runs, workflowRuns, activeOrFailedBuilds, unrunBuildCandidates] =
      await Promise.all([
        prisma.agentRun.findMany({
          where: {
            archivedAt: null,
            status: { in: [...ACTIVE_RUN_STATUSES, "FAILED"] },
          },
          include: {
            worktree: true,
            questionBatches: {
              where: { status: "PENDING" },
              orderBy: { createdAt: "asc" },
              include: questionInclude,
            },
          },
        }),
        prisma.workflowRun.findMany({
          where: {
            archivedAt: null,
            status: { in: [...ACTIVE_WORKFLOW_STATUSES, "FAILED"] },
          },
          include: {
            workflow: true,
            attempts: {
              where: { supersededAt: null },
              include: {
                questionBatches: {
                  where: { status: "PENDING" },
                  orderBy: { createdAt: "asc" },
                  include: questionInclude,
                },
              },
            },
          },
        }),
        prisma.build.findMany({
          where: { status: { in: [...ACTIVE_BUILD_STATUSES, "FAILED"] } },
          include: {
            worktree: true,
            codebase: { include: { repository: true } },
            configuration: true,
            artifacts: true,
            deployments: true,
          },
        }),
        prisma.build.findMany({
          where: {
            status: "SUCCEEDED",
            artifacts: { some: { kind: "RUNNABLE_APP" } },
            deployments: { none: {} },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: {
            worktree: true,
            codebase: { include: { repository: true } },
            configuration: true,
            artifacts: true,
            deployments: true,
          },
        }),
      ]);

    const workflowWorktreeIds = [
      ...new Set(
        workflowRuns.flatMap((run) =>
          workflowWorktreeId(run.sessionDataJson)
            ? [workflowWorktreeId(run.sessionDataJson)!]
            : [],
        ),
      ),
    ];
    const workflowWorktrees = workflowWorktreeIds.length
      ? await prisma.worktree.findMany({
          where: { id: { in: workflowWorktreeIds } },
          select: {
            id: true,
            folder: true,
            branch: true,
            highlightColor: true,
          },
        })
      : [];
    const workflowWorktreeById = new Map(
      workflowWorktrees.map((worktree) => [worktree.id, worktree]),
    );

    const latestUnrunBuilds = new Map<
      string,
      (typeof unrunBuildCandidates)[number]
    >();
    for (const build of unrunBuildCandidates) {
      const key = buildTargetKey(build);
      if (!latestUnrunBuilds.has(key)) latestUnrunBuilds.set(key, build);
    }

    const items: ActionCenterItemView[] = [];
    for (const run of runs) {
      const questions = run.questionBatches.map((batch) =>
        mapQuestionBatch(batch, null),
      );
      const reason: ActionCenterReason =
        questions.length > 0 && run.status !== "FAILED"
          ? "QUESTION"
          : run.status === "FAILED"
            ? "FAILED"
            : run.phase.endsWith("_FAILED") ||
                run.phase === "IMPORTED_ACTIVE_COLLISION"
              ? "BLOCKED"
              : "ACTIVE";
      const fingerprint =
        reason === "FAILED"
          ? failureFingerprint(
              run.kind as ActionCenterResourceKind,
              run.id,
              run.finishedAt ?? run.updatedAt,
            )
          : null;
      items.push({
        key: `${run.kind}:${run.id}`,
        resourceKind: run.kind as "PLAN" | "SESSION",
        reason,
        resourceId: run.id,
        href: runHref(run.kind, run.id),
        displayNumber: run.displayNumber,
        label: compactPrompt(run.initialPrompt),
        summary:
          [run.repositoryName, run.branch].filter(Boolean).join(" · ") || null,
        status: run.status,
        phase: run.phase,
        error: run.error,
        createdAt: iso(run.createdAt),
        updatedAt: iso(run.updatedAt),
        worktree: run.worktree,
        questionBatches: reason === "QUESTION" ? questions : [],
        buildRun: null,
        failureFingerprint: fingerprint,
      });
    }

    for (const run of workflowRuns) {
      const worktreeId = workflowWorktreeId(run.sessionDataJson);
      const questions = run.attempts.flatMap((attempt) =>
        attempt.questionBatches.map((batch) =>
          mapQuestionBatch(batch, attempt.kind),
        ),
      );
      const reason: ActionCenterReason =
        questions.length > 0 && run.status !== "FAILED"
          ? "QUESTION"
          : run.status === "BLOCKED"
            ? "BLOCKED"
            : run.status === "FAILED"
              ? "FAILED"
              : "ACTIVE";
      const fingerprint =
        reason === "FAILED"
          ? failureFingerprint(
              "WORKFLOW",
              run.id,
              run.finishedAt ?? run.updatedAt,
              run.generation,
            )
          : null;
      items.push({
        key: `WORKFLOW:${run.id}`,
        resourceKind: "WORKFLOW",
        reason,
        resourceId: run.id,
        href: workflowHref(run.id),
        displayNumber: run.displayNumber,
        label: run.workflow.name,
        summary: run.triggerSubjectKey || null,
        status: run.status,
        phase: run.phase,
        error: run.blockedReason ?? run.error,
        createdAt: iso(run.createdAt),
        updatedAt: iso(run.updatedAt),
        worktree: worktreeId
          ? (workflowWorktreeById.get(worktreeId) ?? null)
          : null,
        questionBatches: reason === "QUESTION" ? questions : [],
        buildRun: null,
        failureFingerprint: fingerprint,
      });
    }

    const builds = [
      ...activeOrFailedBuilds,
      ...latestUnrunBuilds.values(),
    ].filter(
      (build, index, all) =>
        all.findIndex((candidate) => candidate.id === build.id) === index,
    );
    for (const build of builds) {
      const reason: ActionCenterReason =
        build.status === "FAILED"
          ? "FAILED"
          : build.status === "SUCCEEDED"
            ? "UNRUN_BUILD"
            : "ACTIVE";
      const fingerprint =
        reason === "FAILED"
          ? failureFingerprint(
              "BUILD",
              build.id,
              build.finishedAt ?? build.updatedAt,
            )
          : null;
      const repository = build.codebase?.repository.name ?? null;
      const configuration = build.configuration?.name ?? null;
      items.push({
        key: `BUILD:${build.id}`,
        resourceKind: "BUILD",
        reason,
        resourceId: build.id,
        href: buildHref(build.id),
        displayNumber: null,
        label: configuration ?? repository ?? "iOS build",
        summary:
          [repository, build.worktree?.branch].filter(Boolean).join(" · ") ||
          null,
        status: build.status,
        phase: null,
        error: build.error,
        createdAt: iso(build.createdAt),
        updatedAt: iso(build.updatedAt),
        worktree: build.worktree,
        questionBatches: [],
        buildRun:
          reason === "UNRUN_BUILD"
            ? {
                buildId: build.id,
                destinationType: build.destinationType,
                preferredDestination: parseJson(build.destinationJson),
              }
            : null,
        failureFingerprint: fingerprint,
      });
    }

    const failureKeys = items.flatMap((item) =>
      item.failureFingerprint
        ? [
            {
              resourceKind: item.resourceKind,
              resourceId: item.resourceId,
              failureFingerprint: item.failureFingerprint,
            },
          ]
        : [],
    );
    const acknowledged = failureKeys.length
      ? await prisma.actionCenterAcknowledgement.findMany({
          where: { OR: failureKeys },
          select: {
            resourceKind: true,
            resourceId: true,
            failureFingerprint: true,
          },
        })
      : [];
    const acknowledgedKeys = new Set(
      acknowledged.map((entry) =>
        [entry.resourceKind, entry.resourceId, entry.failureFingerprint].join(
          "\0",
        ),
      ),
    );
    const visible = items
      .filter(
        (item) =>
          !item.failureFingerprint ||
          !acknowledgedKeys.has(
            [item.resourceKind, item.resourceId, item.failureFingerprint].join(
              "\0",
            ),
          ),
      )
      .sort(compareItems);
    const cursor = decodeCursor(input.after);
    const remaining = cursor
      ? visible.filter((item) => afterCursor(item, cursor))
      : visible;
    const page = remaining.slice(0, first);
    const needsAttentionCount = visible.filter(
      ({ reason }) => reason !== "ACTIVE",
    ).length;

    return {
      items: page,
      nextCursor:
        remaining.length > first && page.length
          ? encodeCursor(page[page.length - 1]!)
          : null,
      totalCount: visible.length,
      needsAttentionCount,
      activeCount: visible.length - needsAttentionCount,
    };
  }

  async acknowledge(input: AcknowledgeInput): Promise<boolean> {
    const kind = input.resourceKind.trim().toUpperCase();
    if (!RESOURCE_KINDS.includes(kind as ActionCenterResourceKind)) {
      throw new Error("Action Center resource kind is invalid");
    }
    const resourceKind = kind as ActionCenterResourceKind;
    const prisma = await getPrismaClient();
    let current: string | null = null;
    if (resourceKind === "PLAN" || resourceKind === "SESSION") {
      const run = await prisma.agentRun.findUnique({
        where: { id: input.resourceId },
        select: {
          id: true,
          kind: true,
          status: true,
          finishedAt: true,
          updatedAt: true,
        },
      });
      if (run?.kind === resourceKind && run.status === "FAILED") {
        current = failureFingerprint(
          resourceKind,
          run.id,
          run.finishedAt ?? run.updatedAt,
        );
      }
    } else if (resourceKind === "WORKFLOW") {
      const run = await prisma.workflowRun.findUnique({
        where: { id: input.resourceId },
        select: {
          id: true,
          status: true,
          generation: true,
          finishedAt: true,
          updatedAt: true,
        },
      });
      if (run?.status === "FAILED") {
        current = failureFingerprint(
          "WORKFLOW",
          run.id,
          run.finishedAt ?? run.updatedAt,
          run.generation,
        );
      }
    } else {
      const build = await prisma.build.findUnique({
        where: { id: input.resourceId },
        select: { id: true, status: true, finishedAt: true, updatedAt: true },
      });
      if (build?.status === "FAILED") {
        current = failureFingerprint(
          "BUILD",
          build.id,
          build.finishedAt ?? build.updatedAt,
        );
      }
    }
    if (!current || current !== input.failureFingerprint) {
      throw new Error("Action Center failure is no longer current");
    }
    await prisma.actionCenterAcknowledgement.upsert({
      where: {
        resourceKind_resourceId_failureFingerprint: {
          resourceKind,
          resourceId: input.resourceId,
          failureFingerprint: current,
        },
      },
      create: {
        id: randomUUID(),
        resourceKind,
        resourceId: input.resourceId,
        failureFingerprint: current,
      },
      update: { acknowledgedAt: new Date() },
    });
    agentEventBus.publish(SIDEBAR_STATUS_CHANGED_TOPIC, {
      sidebarStatusChanged: true,
    });
    return true;
  }

  subscribe() {
    return agentEventBus.iterate(SIDEBAR_STATUS_CHANGED_TOPIC);
  }
}
