import { Prisma, type PrismaClient } from "@/generated/prisma/client";

/** Filter and paginate in SQL so run history never becomes an unbounded IN list. */
export async function workflowRunPageForAgent(
  prisma: Pick<PrismaClient, "$queryRaw">,
  input: {
    agentId: string;
    workflowId?: string | null;
    status?: string | null;
    search?: string | null;
    archive?: string | null;
    first: number;
    after?: string | null;
  },
) {
  // Match runAgent's snapshot preference and legacy worktree fallback.
  const owners = Prisma.sql`
    WITH owners AS (
      SELECT run.id, run.createdAt, run.workflowId, run.status,
        run.displayNumber, run.archivedAt,
        COALESCE(
          json_extract(run.sessionDataJson, '$.agent.id'),
          json_extract(run.sessionDataJson, '$.codebase.agentId')
        ) AS snapshotAgentId,
        codebase.agentId AS worktreeAgentId
      FROM WorkflowRun AS run
      LEFT JOIN Worktree AS worktree
        ON worktree.id = json_extract(run.sessionDataJson, '$.worktree.id')
      LEFT JOIN Codebase AS codebase ON codebase.id = worktree.codebaseId
    )`;
  const archive = input.archive?.toUpperCase() ?? "ACTIVE";
  const scope = Prisma.sql`
    CASE
      WHEN typeof(snapshotAgentId) = 'text' AND snapshotAgentId <> ''
        THEN snapshotAgentId
      ELSE worktreeAgentId
    END = ${input.agentId}
    ${
      archive === "ALL"
        ? Prisma.empty
        : archive === "ARCHIVED"
          ? Prisma.sql`AND archivedAt IS NOT NULL`
          : Prisma.sql`AND archivedAt IS NULL`
    }
    ${input.workflowId ? Prisma.sql`AND workflowId = ${input.workflowId}` : Prisma.empty}`;
  const searchNumber = Number(input.search);
  const search = input.search?.trim();
  const searchWhere =
    Number.isInteger(searchNumber) && searchNumber > 0
      ? Prisma.sql`AND displayNumber = ${searchNumber}`
      : search
        ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM Workflow
          WHERE Workflow.id = owners.workflowId
            AND Workflow.name LIKE ${`%${search}%`}
        )`
        : Prisma.empty;
  const cursorWhere = input.after
    ? Prisma.sql`AND (createdAt, id) <= (
        SELECT createdAt, id FROM WorkflowRun WHERE id = ${input.after}
      )`
    : Prisma.empty;
  const [rows, counts] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      ${owners}
      SELECT id FROM owners WHERE ${scope}
        ${input.status ? Prisma.sql`AND status = ${input.status.toUpperCase()}` : Prisma.empty}
        ${searchWhere}
        ${cursorWhere}
      ORDER BY createdAt DESC, id DESC
      LIMIT ${input.first + 1} OFFSET ${input.after ? 1 : 0}
    `),
    prisma.$queryRaw<Array<{ totalCount: bigint }>>(Prisma.sql`
      ${owners}
      SELECT COUNT(*) AS totalCount FROM owners WHERE ${scope}
    `),
  ]);
  return {
    ids: rows.map(({ id }) => id),
    totalCount: Number(counts[0]!.totalCount),
  };
}
