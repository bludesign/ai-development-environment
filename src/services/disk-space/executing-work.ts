import "server-only";

import { getPrismaClient } from "@/data/prisma-client";

export type DerivedDataActiveResource = {
  kind: "BUILD" | "PLAN" | "SESSION" | "WORKFLOW" | "WORKFLOW_JOB";
  id: string;
  label: string;
  href: string;
};

function sessionWorktreeId(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const worktree = (parsed as Record<string, unknown>).worktree;
    if (!worktree || typeof worktree !== "object" || Array.isArray(worktree)) {
      return null;
    }
    const id = (worktree as Record<string, unknown>).id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function add(
  result: Map<string, DerivedDataActiveResource[]>,
  worktreeId: string | null,
  resource: DerivedDataActiveResource,
): void {
  if (!worktreeId || !result.has(worktreeId)) return;
  const resources = result.get(worktreeId)!;
  if (
    !resources.some(
      (item) => item.kind === resource.kind && item.id === resource.id,
    )
  ) {
    resources.push(resource);
  }
}

export async function executingResourcesByWorktree(
  worktreeIds: string[],
): Promise<Map<string, DerivedDataActiveResource[]>> {
  const unique = [...new Set(worktreeIds.filter(Boolean))];
  const result = new Map(
    unique.map((id) => [id, [] as DerivedDataActiveResource[]]),
  );
  if (!unique.length) return result;
  const prisma = await getPrismaClient();
  const [builds, runs, workflowAttempts, workflowJobs] = await Promise.all([
    prisma.build.findMany({
      where: {
        worktreeId: { in: unique },
        OR: [
          { status: { in: ["PREPARING", "RUNNING"] } },
          { status: "QUEUED", job: { status: "RUNNING" } },
        ],
      },
      select: { id: true, worktreeId: true },
    }),
    prisma.agentRun.findMany({
      where: {
        worktreeId: { in: unique },
        attempts: {
          some: {
            status: { in: ["STARTING", "RUNNING"] },
            supersededAt: null,
          },
        },
      },
      select: {
        id: true,
        kind: true,
        displayNumber: true,
        worktreeId: true,
      },
    }),
    prisma.workflowStepAttempt.findMany({
      where: { status: "RUNNING", supersededAt: null },
      select: {
        id: true,
        run: {
          select: { id: true, displayNumber: true, sessionDataJson: true },
        },
      },
    }),
    prisma.agentJob.findMany({
      where: {
        worktreeId: { in: unique },
        status: "RUNNING",
        kind: { startsWith: "workflow." },
      },
      select: { id: true, worktreeId: true },
    }),
  ]);

  for (const build of builds) {
    add(result, build.worktreeId, {
      kind: "BUILD",
      id: build.id,
      label: "Build",
      href: `/builds/${encodeURIComponent(build.id)}`,
    });
  }
  for (const run of runs) {
    const kind = run.kind === "PLAN" ? "PLAN" : "SESSION";
    add(result, run.worktreeId, {
      kind,
      id: run.id,
      label: `${kind === "PLAN" ? "Plan" : "Session"} #${run.displayNumber}`,
      href: `/${kind === "PLAN" ? "plans" : "sessions"}/${encodeURIComponent(run.id)}`,
    });
  }
  for (const attempt of workflowAttempts) {
    add(result, sessionWorktreeId(attempt.run.sessionDataJson), {
      kind: "WORKFLOW",
      id: attempt.run.id,
      label: `Workflow run #${attempt.run.displayNumber}`,
      href: `/workflows/runs/${encodeURIComponent(attempt.run.id)}`,
    });
  }
  for (const job of workflowJobs) {
    add(result, job.worktreeId, {
      kind: "WORKFLOW_JOB",
      id: job.id,
      label: "Workflow terminal job",
      href: `/jobs/${encodeURIComponent(job.id)}`,
    });
  }
  return result;
}
