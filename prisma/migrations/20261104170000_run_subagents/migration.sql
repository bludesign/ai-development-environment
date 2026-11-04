CREATE TABLE "RunSubagent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "nativeId" TEXT NOT NULL,
    "nativeRunId" TEXT,
    "parentNativeId" TEXT,
    "toolUseId" TEXT,
    "label" TEXT NOT NULL,
    "agentType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "prompt" TEXT,
    "finalOutput" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "transcriptStatus" TEXT NOT NULL DEFAULT 'PARTIAL',
    "transcriptError" TEXT,
    "snapshotDigest" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RunSubagent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunSubagent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RunAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "RunSubagentMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subagentId" TEXT NOT NULL,
    "nativeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "rawJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunSubagentMessage_subagentId_fkey" FOREIGN KEY ("subagentId") REFERENCES "RunSubagent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RunSubagent_attemptId_nativeId_key" ON "RunSubagent"("attemptId", "nativeId");
CREATE INDEX "RunSubagent_runId_startedAt_idx" ON "RunSubagent"("runId", "startedAt");
CREATE INDEX "RunSubagent_attemptId_toolUseId_idx" ON "RunSubagent"("attemptId", "toolUseId");
CREATE UNIQUE INDEX "RunSubagentMessage_subagentId_nativeId_key" ON "RunSubagentMessage"("subagentId", "nativeId");
CREATE INDEX "RunSubagentMessage_subagentId_createdAt_id_idx" ON "RunSubagentMessage"("subagentId", "createdAt", "id");
