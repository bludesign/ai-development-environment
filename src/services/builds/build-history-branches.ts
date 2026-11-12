import { Prisma, type PrismaClient } from "@/generated/prisma/client";

type BuildScope = {
  appId?: string | null;
  repositoryId?: string | null;
  configurationId?: string | null;
  codebaseId?: string | null;
  worktreeId?: string | null;
};

const scopeWhere = (input: BuildScope) => Prisma.sql`
  1 = 1
  ${input.repositoryId ? Prisma.sql`AND b.repositoryId = ${input.repositoryId}` : Prisma.empty}
  ${input.configurationId ? Prisma.sql`AND (b.configurationId = ${input.configurationId} OR b.androidConfigurationId = ${input.configurationId})` : Prisma.empty}
  ${input.codebaseId ? Prisma.sql`AND b.codebaseId = ${input.codebaseId}` : Prisma.empty}
  ${input.worktreeId ? Prisma.sql`AND b.worktreeId = ${input.worktreeId}` : Prisma.empty}
  ${input.appId ? Prisma.sql`AND EXISTS (SELECT 1 FROM AppRepository a WHERE a.repositoryId = b.repositoryId AND a.appId = ${input.appId})` : Prisma.empty}
`;

// Invalid legacy snapshots must not make otherwise valid build history fail.
const branchValue = Prisma.sql`CASE WHEN json_valid(b.snapshotJson)
  THEN json_extract(b.snapshotJson, '$.worktree.branch') END`;
const branchType = Prisma.sql`CASE WHEN json_valid(b.snapshotJson)
  THEN json_type(b.snapshotJson, '$.worktree.branch') END`;

export async function historicalBuildBranches(
  prisma: Pick<PrismaClient, "$queryRaw">,
  input: BuildScope,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ branch: string }>>(Prisma.sql`
    SELECT DISTINCT ${branchValue} AS branch FROM Build b
    WHERE ${scopeWhere(input)}
      AND ${branchType} = 'text' AND ${branchValue} <> ''
    ORDER BY branch COLLATE NOCASE, branch
  `);
  return rows.map(({ branch }) => branch);
}

/** Filter and paginate before hydration; never build an unbounded IN list. */
export async function historicalBranchBuildIds(
  prisma: Pick<PrismaClient, "$queryRaw">,
  input: BuildScope & {
    branch: string;
    status?: string | null;
    after?: string | null;
    first: number;
  },
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT b.id FROM Build b WHERE ${scopeWhere(input)}
      AND ${branchType} = 'text' AND ${branchValue} = ${input.branch} COLLATE BINARY
      ${input.status ? Prisma.sql`AND b.status = ${input.status}` : Prisma.empty}
      ${input.after ? Prisma.sql`AND (b.createdAt, b.id) < (SELECT createdAt, id FROM Build WHERE id = ${input.after})` : Prisma.empty}
    ORDER BY b.createdAt DESC, b.id DESC LIMIT ${input.first + 1}
  `);
  return rows.map(({ id }) => id);
}
