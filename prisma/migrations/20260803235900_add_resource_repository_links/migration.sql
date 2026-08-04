ALTER TABLE "AgentRun" ADD COLUMN "repositoryId" TEXT REFERENCES "CodebaseRepository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "AgentRun"
SET "repositoryId" = (
  SELECT "Codebase"."repositoryId"
  FROM "Worktree"
  INNER JOIN "Codebase" ON "Codebase"."id" = "Worktree"."codebaseId"
  WHERE "Worktree"."id" = "AgentRun"."worktreeId"
)
WHERE "repositoryId" IS NULL AND "worktreeId" IS NOT NULL;

CREATE INDEX "AgentRun_repositoryId_kind_archivedAt_createdAt_idx"
ON "AgentRun"("repositoryId", "kind", "archivedAt", "createdAt");

ALTER TABLE "Build" ADD COLUMN "repositoryId" TEXT REFERENCES "CodebaseRepository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "Build"
SET "repositoryId" = COALESCE(
  (
    SELECT "Codebase"."repositoryId"
    FROM "Codebase"
    WHERE "Codebase"."id" = "Build"."codebaseId"
  ),
  (
    SELECT "Codebase"."repositoryId"
    FROM "Worktree"
    INNER JOIN "Codebase" ON "Codebase"."id" = "Worktree"."codebaseId"
    WHERE "Worktree"."id" = "Build"."worktreeId"
  )
)
WHERE "repositoryId" IS NULL;

CREATE INDEX "Build_repositoryId_createdAt_idx"
ON "Build"("repositoryId", "createdAt");
