ALTER TABLE "AgentRun" ADD COLUMN "mcpPresetIdsJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "AgentRun" ADD COLUMN "mcpToolNamesJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "RunDraft" ADD COLUMN "mcpPresetIdsJson" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE "McpToolPreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "iconKey" TEXT NOT NULL DEFAULT 'wrench',
    "enabledForPlans" BOOLEAN NOT NULL DEFAULT false,
    "enabledForSessions" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "McpToolPresetTool" (
    "presetId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("presetId", "toolName"),
    CONSTRAINT "McpToolPresetTool_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "McpToolPreset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "McpToolPreset_name_idx" ON "McpToolPreset"("name");
CREATE INDEX "McpToolPreset_enabledForPlans_name_idx" ON "McpToolPreset"("enabledForPlans", "name");
CREATE INDEX "McpToolPreset_enabledForSessions_name_idx" ON "McpToolPreset"("enabledForSessions", "name");
CREATE INDEX "McpToolPresetTool_toolName_idx" ON "McpToolPresetTool"("toolName");
