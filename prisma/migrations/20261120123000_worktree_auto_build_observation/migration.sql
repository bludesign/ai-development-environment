ALTER TABLE "WorktreeAutoBuild" ADD COLUMN "lastQueuedObservationAt" DATETIME;

UPDATE "WorktreeAutoBuild"
SET "lastQueuedObservationAt" = (
    SELECT "lastCheckedAt" FROM "Worktree"
    WHERE "Worktree"."id" = "WorktreeAutoBuild"."worktreeId"
)
WHERE "lastQueuedBuildId" IS NOT NULL;
