ALTER TABLE "AgentRun" ADD COLUMN "mcpToolSnapshotJson" TEXT;

CREATE TABLE "McpToolPresetExternalTool" (
    "presetId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    PRIMARY KEY ("presetId", "serverId", "toolName"),
    CONSTRAINT "McpToolPresetExternalTool_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "McpToolPreset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "McpToolPresetExternalTool_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "ExternalMcpServer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "McpToolPresetExternalTool_serverId_idx" ON "McpToolPresetExternalTool"("serverId");
