CREATE TABLE "ToolCallAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "correlationId" TEXT NOT NULL,
    "caller" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argumentsSha256" TEXT NOT NULL,
    "resultStatus" TEXT NOT NULL,
    "durationMs" INTEGER,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

CREATE INDEX "ToolCallAudit_startedAt_idx" ON "ToolCallAudit"("startedAt");
CREATE INDEX "ToolCallAudit_toolName_startedAt_idx" ON "ToolCallAudit"("toolName", "startedAt");
CREATE INDEX "ToolCallAudit_correlationId_idx" ON "ToolCallAudit"("correlationId");
CREATE INDEX "ToolCallAudit_resultStatus_startedAt_idx" ON "ToolCallAudit"("resultStatus", "startedAt");
