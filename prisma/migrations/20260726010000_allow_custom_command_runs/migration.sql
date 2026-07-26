PRAGMA foreign_keys=OFF;

CREATE TABLE "new_CommandRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayNumber" INTEGER NOT NULL,
    "commandId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "snapshotName" TEXT NOT NULL,
    "snapshotDescription" TEXT NOT NULL DEFAULT '',
    "snapshotScript" TEXT NOT NULL,
    "snapshotTargetKind" TEXT NOT NULL,
    "snapshotRestartPolicy" TEXT NOT NULL DEFAULT 'NEVER',
    "snapshotRestartLimit" INTEGER,
    "snapshotNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "snapshotJson" TEXT NOT NULL DEFAULT '{}',
    "agentId" TEXT,
    "worktreeId" TEXT,
    "agentName" TEXT NOT NULL,
    "agentHostname" TEXT NOT NULL,
    "worktreePath" TEXT,
    "worktreeBranch" TEXT,
    "restartCount" INTEGER NOT NULL DEFAULT 0,
    "stopRequested" BOOLEAN NOT NULL DEFAULT false,
    "nextRestartAt" DATETIME,
    "predecessorRunId" TEXT,
    "error" TEXT,
    "exitCode" INTEGER,
    "signal" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CommandRun_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "CommandDefinition" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CommandRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CommandRun_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CommandRun_predecessorRunId_fkey" FOREIGN KEY ("predecessorRunId") REFERENCES "new_CommandRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_CommandRun" (
    "id", "displayNumber", "commandId", "idempotencyKey", "origin", "status",
    "snapshotName", "snapshotDescription", "snapshotScript", "snapshotTargetKind",
    "snapshotRestartPolicy", "snapshotRestartLimit", "snapshotNotificationsEnabled",
    "snapshotJson", "agentId", "worktreeId", "agentName", "agentHostname",
    "worktreePath", "worktreeBranch", "restartCount", "stopRequested",
    "nextRestartAt", "predecessorRunId", "error", "exitCode", "signal", "queuedAt",
    "startedAt", "finishedAt", "archivedAt", "createdAt", "updatedAt"
)
SELECT
    "id", "displayNumber", "commandId", "idempotencyKey", "origin", "status",
    "snapshotName", "snapshotDescription", "snapshotScript", "snapshotTargetKind",
    "snapshotRestartPolicy", "snapshotRestartLimit", "snapshotNotificationsEnabled",
    "snapshotJson", "agentId", "worktreeId", "agentName", "agentHostname",
    "worktreePath", "worktreeBranch", "restartCount", "stopRequested",
    "nextRestartAt", "predecessorRunId", "error", "exitCode", "signal", "queuedAt",
    "startedAt", "finishedAt", "archivedAt", "createdAt", "updatedAt"
FROM "CommandRun";

DROP TABLE "CommandRun";
ALTER TABLE "new_CommandRun" RENAME TO "CommandRun";

CREATE UNIQUE INDEX "CommandRun_displayNumber_key" ON "CommandRun"("displayNumber");
CREATE UNIQUE INDEX "CommandRun_idempotencyKey_key" ON "CommandRun"("idempotencyKey");
CREATE UNIQUE INDEX "CommandRun_predecessorRunId_key" ON "CommandRun"("predecessorRunId");
CREATE INDEX "CommandRun_commandId_createdAt_idx" ON "CommandRun"("commandId", "createdAt");
CREATE INDEX "CommandRun_agentId_status_createdAt_idx" ON "CommandRun"("agentId", "status", "createdAt");
CREATE INDEX "CommandRun_worktreeId_status_createdAt_idx" ON "CommandRun"("worktreeId", "status", "createdAt");
CREATE INDEX "CommandRun_archivedAt_createdAt_idx" ON "CommandRun"("archivedAt", "createdAt");
CREATE INDEX "CommandRun_status_nextRestartAt_idx" ON "CommandRun"("status", "nextRestartAt");

PRAGMA foreign_keys=ON;
