ALTER TABLE "Worktree" ADD COLUMN "pushStatus" TEXT NOT NULL DEFAULT 'UNKNOWN';

CREATE TABLE "WorktreeMove" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "sourceWorktreeId" TEXT NOT NULL,
    "sourceCodebaseId" TEXT NOT NULL,
    "targetCodebaseId" TEXT NOT NULL,
    "targetWorktreeId" TEXT,
    "destinationMode" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "deleteSource" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "sourceJobId" TEXT,
    "targetJobId" TEXT,
    "cleanupJobId" TEXT,
    "error" TEXT,
    "warning" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME
);

CREATE UNIQUE INDEX "WorktreeMove_sourceWorktreeId_requestId_key"
ON "WorktreeMove"("sourceWorktreeId", "requestId");
CREATE INDEX "WorktreeMove_status_updatedAt_idx"
ON "WorktreeMove"("status", "updatedAt");
CREATE INDEX "WorktreeMove_sourceJobId_idx" ON "WorktreeMove"("sourceJobId");
CREATE INDEX "WorktreeMove_targetJobId_idx" ON "WorktreeMove"("targetJobId");
CREATE INDEX "WorktreeMove_cleanupJobId_idx" ON "WorktreeMove"("cleanupJobId");
