ALTER TABLE "AgentJob" ADD COLUMN "operationResourcesJson" TEXT;
ALTER TABLE "AgentJob" ADD COLUMN "executionToken" TEXT;
ALTER TABLE "BuildScript" ADD COLUMN "lockScope" TEXT NOT NULL DEFAULT 'WORKTREE';
ALTER TABLE "Codebase" ADD COLUMN "worktreeInventoryObservedAt" DATETIME;
ALTER TABLE "WorktreeMove" ADD COLUMN "operationHolderId" TEXT;

CREATE TABLE "OperationHolder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerKind" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'REQUESTED',
  "executionToken" TEXT,
  "resultJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "OperationHolder_ownerKind_ownerId_key" ON "OperationHolder"("ownerKind", "ownerId");
CREATE INDEX "OperationHolder_state_createdAt_idx" ON "OperationHolder"("state", "createdAt");
CREATE TABLE "OperationResource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "holderId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "agentId" TEXT,
  "codebaseId" TEXT,
  "path" TEXT,
  CONSTRAINT "OperationResource_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "OperationHolder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OperationResource_key_idx" ON "OperationResource"("key");
CREATE INDEX "OperationResource_agentId_codebaseId_idx" ON "OperationResource"("agentId", "codebaseId");
CREATE INDEX "OperationResource_holderId_idx" ON "OperationResource"("holderId");
CREATE TABLE "OperationAdmissionLane" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "updatedAt" DATETIME NOT NULL
);

-- In-flight legacy executions retain conservative protection until acknowledged.
-- Drain existing builds/providers on their original agents before replacing
-- pre-protocol agents: old detached children have no verifiable process identity.
INSERT INTO "OperationHolder" ("id", "ownerKind", "ownerId", "state", "createdAt", "updatedAt")
SELECT 'job:' || "id", 'AGENT_JOB', "id",
  CASE WHEN "status" = 'QUEUED' THEN 'REQUESTED' ELSE 'HELD' END,
  "createdAt", CURRENT_TIMESTAMP
FROM "AgentJob" WHERE "codebaseId" IS NOT NULL AND "status" IN ('QUEUED', 'RUNNING', 'CANCELLING');
INSERT INTO "OperationResource" ("id", "holderId", "kind", "key", "mode", "agentId", "codebaseId")
SELECT 'legacy:' || "id", 'job:' || "id", 'CODEBASE',
  "agentId" || ':codebase:' || "codebaseId", 'WRITE', "agentId", "codebaseId"
FROM "AgentJob" WHERE "codebaseId" IS NOT NULL AND "status" IN ('QUEUED', 'RUNNING', 'CANCELLING');

-- Existing managed providers keep source-stability protection until their
-- physical execution reports completion; run reservations themselves are unchanged.
INSERT INTO "OperationHolder" ("id", "ownerKind", "ownerId", "state", "executionToken", "createdAt", "updatedAt")
SELECT 'AGENT_RUN:' || rc."id", 'AGENT_RUN', rc."id", 'HELD',
  'run:' || rc."agentId" || ':' || rc."id", COALESCE(rc."claimedAt", rc."createdAt"), CURRENT_TIMESTAMP
FROM "RunCommand" rc JOIN "AgentRun" r ON r."id" = rc."runId" JOIN "Worktree" w ON w."id" = r."worktreeId"
WHERE rc."status" = 'RUNNING' AND r."kind" = 'SESSION' AND r."origin" = 'MANAGED'
  AND rc."type" IN ('START', 'PLAY_PLAN', 'CONTINUE', 'REVISE_ANSWER');
INSERT INTO "OperationResource" ("id", "holderId", "kind", "key", "mode", "agentId", "codebaseId")
SELECT 'run-stability:' || rc."id", 'AGENT_RUN:' || rc."id", 'WORKTREE',
  rc."agentId" || ':build-stability:' || w."gitDirectory", 'READ', rc."agentId", w."codebaseId"
FROM "RunCommand" rc JOIN "AgentRun" r ON r."id" = rc."runId" JOIN "Worktree" w ON w."id" = r."worktreeId"
WHERE rc."status" = 'RUNNING' AND r."kind" = 'SESSION' AND r."origin" = 'MANAGED'
  AND rc."type" IN ('START', 'PLAY_PLAN', 'CONTINUE', 'REVISE_ANSWER');

DROP INDEX IF EXISTS "AgentJob_codebaseId_active_key";
DROP TRIGGER IF EXISTS "AgentJob_codebase_command_guard_insert";
DROP TRIGGER IF EXISTS "AgentJob_codebase_command_guard_update";
