import "server-only";

import { getPrismaClient } from "@/data/prisma-client";

export type CommandResourceKind = "AGENT" | "WORKTREE";
export type CommandTargetSummaryInput = {
  resourceKind: CommandResourceKind;
  resourceId: string;
  includeAllCommands?: boolean | null;
  includeRecentRuns?: boolean | null;
};

const ACTIVE = ["QUEUED", "RUNNING", "RESTARTING", "CANCELLING"];
const targetKey = (target: CommandTargetSummaryInput) =>
  JSON.stringify([target.resourceKind, target.resourceId]);

/** One definition/active-run read for a batch; history is limited per target in SQL. */
export async function loadCommandTargetSummaries(
  input: CommandTargetSummaryInput[],
) {
  if (input.length > 200)
    throw new Error("At most 200 command targets are allowed");
  const unique = new Map<string, CommandTargetSummaryInput>();
  for (const target of input) {
    if (
      !["AGENT", "WORKTREE"].includes(target.resourceKind) ||
      !target.resourceId.trim()
    )
      throw new Error("Invalid command target");
    const previous = unique.get(targetKey(target));
    unique.set(targetKey(target), {
      ...target,
      includeAllCommands: Boolean(
        previous?.includeAllCommands || target.includeAllCommands,
      ),
      includeRecentRuns: Boolean(
        previous?.includeRecentRuns || target.includeRecentRuns,
      ),
    });
  }
  const targets = [...unique.values()];
  if (!targets.length) return [];
  const prisma = await getPrismaClient();
  const agentIds = targets
    .filter((target) => target.resourceKind === "AGENT")
    .map((target) => target.resourceId);
  const worktreeIds = targets
    .filter((target) => target.resourceKind === "WORKTREE")
    .map((target) => target.resourceId);
  const worktrees = worktreeIds.length
    ? await prisma.worktree.findMany({
        where: { id: { in: worktreeIds } },
        select: { id: true, codebase: { select: { repositoryId: true } } },
      })
    : [];
  const repositories = new Map(
    worktrees.map((worktree) => [worktree.id, worktree.codebase.repositoryId]),
  );
  const definitions = await prisma.commandDefinition.findMany({
    where: {
      archivedAt: null,
      ...(targets.some((target) => target.includeAllCommands)
        ? {}
        : { quickActionEnabled: true }),
      OR: [
        ...(agentIds.length
          ? [
              { targetKind: "ANY_AGENT_HOME" },
              {
                targetKind: "SPECIFIC_AGENT_HOME",
                targetAgentId: { in: agentIds },
              },
            ]
          : []),
        ...(worktrees.length
          ? [
              { targetKind: "ANY_WORKTREE" },
              {
                targetKind: "REPOSITORY_WORKTREE",
                repositories: {
                  some: {
                    repositoryId: { in: [...new Set(repositories.values())] },
                  },
                },
              },
            ]
          : []),
      ],
    },
    select: {
      id: true,
      name: true,
      description: true,
      targetKind: true,
      targetAgentId: true,
      quickActionEnabled: true,
      quickActionIconKey: true,
      quickActionButtonVariant: true,
      repositories: { select: { repositoryId: true } },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const summaries = targets.map((target) => {
    const eligible = definitions.filter((definition) => {
      if (!target.includeAllCommands && !definition.quickActionEnabled)
        return false;
      if (target.resourceKind === "AGENT")
        return (
          definition.targetKind === "ANY_AGENT_HOME" ||
          (definition.targetKind === "SPECIFIC_AGENT_HOME" &&
            definition.targetAgentId === target.resourceId)
        );
      const repositoryId = repositories.get(target.resourceId);
      return Boolean(
        repositoryId &&
        (definition.targetKind === "ANY_WORKTREE" ||
          (definition.targetKind === "REPOSITORY_WORKTREE" &&
            definition.repositories.some(
              (entry) => entry.repositoryId === repositoryId,
            ))),
      );
    });
    return {
      resourceKind: target.resourceKind,
      resourceId: target.resourceId,
      commands: eligible.map(
        ({
          targetAgentId: _agent,
          repositories: _repositories,
          ...definition
        }) => definition,
      ),
      activeRuns: [] as Array<{
        id: string;
        commandId: string;
        displayNumber: number;
        status: string;
      }>,
      recentRuns: [] as Array<{
        id: string;
        snapshotName: string;
        displayNumber: number | bigint;
        status: string;
        createdAt: string;
      }>,
    };
  });
  const activeTargets = summaries.filter((summary) =>
    summary.commands.some((command) => command.quickActionEnabled),
  );
  if (activeTargets.length) {
    const runs = await prisma.commandRun.findMany({
      where: {
        archivedAt: null,
        status: { in: ACTIVE },
        OR: activeTargets.map((summary) => ({
          [summary.resourceKind === "AGENT" ? "agentId" : "worktreeId"]:
            summary.resourceId,
          commandId: {
            in: summary.commands
              .filter((command) => command.quickActionEnabled)
              .map((command) => command.id),
          },
        })),
      },
      select: {
        id: true,
        commandId: true,
        agentId: true,
        worktreeId: true,
        displayNumber: true,
        status: true,
      },
      orderBy: { displayNumber: "asc" },
    });
    for (const summary of activeTargets) {
      const commandIds = new Set(
        summary.commands
          .filter((command) => command.quickActionEnabled)
          .map((command) => command.id),
      );
      summary.activeRuns = runs
        .filter(
          (run) =>
            (summary.resourceKind === "AGENT"
              ? run.agentId
              : run.worktreeId) === summary.resourceId &&
            run.commandId !== null &&
            commandIds.has(run.commandId),
        )
        .map((run) => ({
          id: run.id,
          commandId: run.commandId!,
          displayNumber: run.displayNumber,
          status: run.status,
        }));
    }
  }
  const recentTargets = targets.filter((target) => target.includeRecentRuns);
  if (recentTargets.length) {
    // Values are parameters, never interpolated. A global LIMIT would hide one
    // target's history behind another target's runs, so rank each target first.
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        resourceKind: CommandResourceKind;
        resourceId: string;
        id: string;
        snapshotName: string;
        displayNumber: number;
        status: string;
        createdAt: Date | string | number | bigint;
      }>
    >(
      `WITH targets(resourceKind, resourceId) AS (VALUES ${recentTargets.map(() => "(?, ?)").join(", ")}),
      ranked AS (
        SELECT targets.resourceKind, targets.resourceId, r.id, r.snapshotName,
          r.displayNumber, r.status, r.createdAt,
          ROW_NUMBER() OVER (PARTITION BY targets.resourceKind, targets.resourceId ORDER BY r.createdAt DESC, r.id DESC) AS position
        FROM targets JOIN CommandRun r ON
          (targets.resourceKind = 'AGENT' AND r.agentId = targets.resourceId) OR
          (targets.resourceKind = 'WORKTREE' AND r.worktreeId = targets.resourceId)
        WHERE r.archivedAt IS NULL
      ) SELECT resourceKind, resourceId, id, snapshotName, displayNumber, status, createdAt
        FROM ranked WHERE position <= 8 ORDER BY resourceKind, resourceId, position`,
      ...recentTargets.flatMap((target) => [
        target.resourceKind,
        target.resourceId,
      ]),
    );
    for (const summary of summaries)
      summary.recentRuns = rows
        .filter(
          (row) =>
            row.resourceKind === summary.resourceKind &&
            row.resourceId === summary.resourceId,
        )
        .map(({ resourceKind: _kind, resourceId: _id, ...row }) => ({
          ...row,
          displayNumber: Number(row.displayNumber),
          createdAt: new Date(
            typeof row.createdAt === "bigint"
              ? Number(row.createdAt)
              : row.createdAt,
          ).toISOString(),
        }));
  }
  return summaries;
}
