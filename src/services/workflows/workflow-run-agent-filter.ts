import { Prisma, type PrismaClient } from "@/generated/prisma/client";

/** Match runAgent's snapshot preference and legacy worktree fallback in SQL. */
export async function workflowRunIdsForAgent(
  prisma: Pick<PrismaClient, "$queryRaw">,
  agentId: string,
) {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH owners AS (
      SELECT run.id,
        COALESCE(
          json_extract(run.sessionDataJson, '$.agent.id'),
          json_extract(run.sessionDataJson, '$.codebase.agentId')
        ) AS snapshotAgentId,
        codebase.agentId AS worktreeAgentId
      FROM WorkflowRun AS run
      LEFT JOIN Worktree AS worktree
        ON worktree.id = json_extract(run.sessionDataJson, '$.worktree.id')
      LEFT JOIN Codebase AS codebase ON codebase.id = worktree.codebaseId
    )
    SELECT id FROM owners
    WHERE CASE
      WHEN typeof(snapshotAgentId) = 'text' AND snapshotAgentId <> ''
        THEN snapshotAgentId
      ELSE worktreeAgentId
    END = ${agentId}
  `);
  return rows.map(({ id }) => id);
}
