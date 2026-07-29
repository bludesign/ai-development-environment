ALTER TABLE "AgentRun" ADD COLUMN "worktreeConcurrencyLimit" INTEGER NOT NULL DEFAULT 0;

UPDATE "AgentRun"
SET "worktreeConcurrencyLimit" = 1
WHERE "kind" = 'SESSION';

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_WorktreeRunLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "worktreeId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorktreeRunLease_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorktreeRunLease_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_WorktreeRunLease" ("id", "worktreeId", "runId", "acquiredAt")
SELECT "runId", "worktreeId", "runId", "acquiredAt"
FROM "WorktreeRunLease";

DROP TABLE "WorktreeRunLease";
ALTER TABLE "new_WorktreeRunLease" RENAME TO "WorktreeRunLease";

CREATE UNIQUE INDEX "WorktreeRunLease_runId_key" ON "WorktreeRunLease"("runId");
CREATE INDEX "WorktreeRunLease_worktreeId_acquiredAt_idx" ON "WorktreeRunLease"("worktreeId", "acquiredAt");

CREATE TABLE "WorktreeRunConcurrencyLane" (
    "worktreeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("worktreeId", "kind"),
    CONSTRAINT "WorktreeRunConcurrencyLane_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AgentRun_worktreeId_kind_status_createdAt_idx"
ON "AgentRun"("worktreeId", "kind", "status", "createdAt");

INSERT OR IGNORE INTO "WorktreeRunConcurrencyLane" ("worktreeId", "kind", "updatedAt")
SELECT DISTINCT "worktreeId", "kind", CURRENT_TIMESTAMP
FROM "AgentRun"
WHERE "origin" = 'MANAGED'
  AND "worktreeId" IS NOT NULL
  AND "status" IN ('IN_PROGRESS', 'PAUSED');

INSERT OR IGNORE INTO "WorktreeRunLease" ("id", "worktreeId", "runId", "acquiredAt")
SELECT "id", "worktreeId", "id", COALESCE("startedAt", "createdAt")
FROM "AgentRun"
WHERE "origin" = 'MANAGED'
  AND "worktreeId" IS NOT NULL
  AND "status" IN ('IN_PROGRESS', 'PAUSED');

PRAGMA foreign_keys=ON;
