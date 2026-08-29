import "server-only";

import { randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  SIDEBAR_STATUS_CHANGED_TOPIC,
} from "@/services/agent-control";
import { getSessionValue } from "@/lib/workflows/session";

import {
  queryActionCenterIndex,
  type ActionCenterIndexCursor,
} from "./action-center-index";

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
  dismissalFingerprint: string | null;
};

type AcknowledgeInput = {
  resourceKind: string;
  resourceId: string;
  failureFingerprint: string;
};

type DismissInput = {
  resourceKind: string;
  resourceId: string;
  dismissalFingerprint: string;
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

function unrunBuildFingerprint(id: string): string {
  return `BUILD:${id}:UNRUN_BUILD`;
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

function encodeCursor(item: ActionCenterItemView): string {
  return Buffer.from(
    JSON.stringify({
      priority: priority(item.reason),
      updatedAt: item.updatedAt,
      key: item.key,
    } satisfies ActionCenterIndexCursor),
  ).toString("base64url");
}

function decodeCursor(
  value: string | null | undefined,
): ActionCenterIndexCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ActionCenterIndexCursor>;
    if (
      typeof parsed.priority !== "number" ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.key !== "string"
    ) {
      return null;
    }
    return parsed as ActionCenterIndexCursor;
  } catch {
    return null;
  }
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

function workflowWorktreeId(sessionDataJson: string): string | null {
  const value = getSessionValue(parseJson(sessionDataJson), "worktree.id");
  return typeof value === "string" && value ? value : null;
}

export class ActionCenterService {
  async list(input: { first?: number | null; after?: string | null } = {}) {
    const prisma = await getPrismaClient();
    const first = Math.max(1, Math.min(input.first ?? 50, 200));
    const index = await queryActionCenterIndex(prisma, {
      first,
      cursor: decodeCursor(input.after),
    });
    const selectedRows = index.rows.slice(0, first);
    const runIds = selectedRows.flatMap((row) =>
      row.resourceKind === "PLAN" || row.resourceKind === "SESSION"
        ? [row.resourceId]
        : [],
    );
    const workflowRunIds = selectedRows.flatMap((row) =>
      row.resourceKind === "WORKFLOW" ? [row.resourceId] : [],
    );
    const buildIds = selectedRows.flatMap((row) =>
      row.resourceKind === "BUILD" ? [row.resourceId] : [],
    );
    const [runs, workflowRuns, builds] = await Promise.all([
      runIds.length
        ? prisma.agentRun.findMany({
            where: { id: { in: runIds } },
            take: runIds.length,
            include: {
              worktree: true,
              questionBatches: {
                where: { status: "PENDING" },
                orderBy: { createdAt: "asc" },
                include: questionInclude,
              },
            },
          })
        : Promise.resolve([]),
      workflowRunIds.length
        ? prisma.workflowRun.findMany({
            where: { id: { in: workflowRunIds } },
            take: workflowRunIds.length,
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
          })
        : Promise.resolve([]),
      buildIds.length
        ? prisma.build.findMany({
            where: { id: { in: buildIds } },
            take: buildIds.length,
            include: {
              worktree: true,
              codebase: { include: { repository: true } },
              configuration: true,
            },
          })
        : Promise.resolve([]),
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

    const indexedReasons = new Map(
      selectedRows.map((row) => [row.key, row.reason as ActionCenterReason]),
    );
    const hydratedItems: ActionCenterItemView[] = [];
    for (const run of runs) {
      const key = `${run.kind}:${run.id}`;
      const reason = indexedReasons.get(key);
      if (!reason) continue;
      const questions = run.questionBatches.map((batch) =>
        mapQuestionBatch(batch, null),
      );
      const fingerprint =
        reason === "FAILED"
          ? failureFingerprint(
              run.kind as ActionCenterResourceKind,
              run.id,
              run.finishedAt ?? run.updatedAt,
            )
          : null;
      hydratedItems.push({
        key,
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
        dismissalFingerprint: null,
      });
    }

    for (const run of workflowRuns) {
      const key = `WORKFLOW:${run.id}`;
      const reason = indexedReasons.get(key);
      if (!reason) continue;
      const worktreeId = workflowWorktreeId(run.sessionDataJson);
      const questions = run.attempts.flatMap((attempt) =>
        attempt.questionBatches.map((batch) =>
          mapQuestionBatch(batch, attempt.kind),
        ),
      );
      const fingerprint =
        reason === "FAILED"
          ? failureFingerprint(
              "WORKFLOW",
              run.id,
              run.finishedAt ?? run.updatedAt,
              run.generation,
            )
          : null;
      hydratedItems.push({
        key,
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
        dismissalFingerprint: null,
      });
    }

    for (const build of builds) {
      const key = `BUILD:${build.id}`;
      const reason = indexedReasons.get(key);
      if (!reason) continue;
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
      hydratedItems.push({
        key,
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
        dismissalFingerprint:
          reason === "UNRUN_BUILD" ? unrunBuildFingerprint(build.id) : null,
      });
    }

    const hydratedByKey = new Map(
      hydratedItems.map((item) => [item.key, item]),
    );
    const items = selectedRows.flatMap((row) =>
      hydratedByKey.has(row.key) ? [hydratedByKey.get(row.key)!] : [],
    );

    return {
      items,
      nextCursor:
        index.rows.length > first && items.length
          ? encodeCursor(items[items.length - 1]!)
          : null,
      totalCount: index.totalCount,
      needsAttentionCount: index.needsAttentionCount,
      activeCount: index.activeCount,
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

  async dismiss(input: DismissInput): Promise<boolean> {
    const resourceKind = input.resourceKind.trim().toUpperCase();
    if (resourceKind !== "BUILD") {
      throw new Error("Only unrun builds can be dismissed");
    }
    const prisma = await getPrismaClient();
    const build = await prisma.build.findUnique({
      where: { id: input.resourceId },
      include: {
        artifacts: { select: { kind: true } },
        deployments: { select: { id: true } },
        worktree: { select: { id: true, availability: true, missingAt: true } },
      },
    });
    if (
      !build ||
      build.status !== "SUCCEEDED" ||
      !build.worktree ||
      build.worktree.missingAt ||
      build.worktree.availability !== "AVAILABLE" ||
      !build.artifacts.some((artifact) => artifact.kind === "RUNNABLE_APP") ||
      build.deployments.length > 0
    ) {
      throw new Error("Action Center item is no longer dismissible");
    }
    if (build.worktreeId && build.configurationId) {
      const latest = await prisma.build.findFirst({
        where: {
          worktreeId: build.worktreeId,
          configurationId: build.configurationId,
          destinationType: build.destinationType,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (latest?.id !== build.id) {
        throw new Error("Action Center item is no longer dismissible");
      }
    }
    const current = unrunBuildFingerprint(build.id);
    if (current !== input.dismissalFingerprint) {
      throw new Error("Action Center dismissal is no longer current");
    }
    await prisma.actionCenterAcknowledgement.upsert({
      where: {
        resourceKind_resourceId_failureFingerprint: {
          resourceKind,
          resourceId: build.id,
          failureFingerprint: current,
        },
      },
      create: {
        id: randomUUID(),
        resourceKind,
        resourceId: build.id,
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
