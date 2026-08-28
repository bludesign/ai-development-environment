PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "CommandDefinitionRepository" (
    "commandId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("commandId", "repositoryId"),
    CONSTRAINT "CommandDefinitionRepository_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "CommandDefinition" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CommandDefinitionRepository_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "CommandDefinitionRepository" ("commandId", "repositoryId")
SELECT "id", "targetRepositoryId"
FROM "CommandDefinition"
WHERE "targetRepositoryId" IS NOT NULL;

CREATE INDEX "CommandDefinitionRepository_repositoryId_commandId_idx"
ON "CommandDefinitionRepository"("repositoryId", "commandId");

CREATE TABLE "new_CommandDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "script" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetAgentId" TEXT,
    "restartPolicy" TEXT NOT NULL DEFAULT 'NEVER',
    "restartLimit" INTEGER DEFAULT 3,
    "concurrency" TEXT NOT NULL DEFAULT 'NON_EXCLUSIVE',
    "blocksGitOperations" BOOLEAN NOT NULL DEFAULT false,
    "quickActionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quickActionIconKey" TEXT NOT NULL DEFAULT 'terminal',
    "quickActionButtonVariant" TEXT NOT NULL DEFAULT 'default',
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CommandDefinition_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_CommandDefinition" (
    "id", "name", "description", "script", "targetKind", "targetAgentId",
    "restartPolicy", "restartLimit", "concurrency", "blocksGitOperations",
    "quickActionEnabled", "quickActionIconKey", "quickActionButtonVariant",
    "notificationsEnabled", "archivedAt", "createdAt", "updatedAt"
)
SELECT
    "id", "name", "description", "script", "targetKind", "targetAgentId",
    "restartPolicy", "restartLimit", "concurrency", "blocksGitOperations",
    "quickActionEnabled", "quickActionIconKey", "quickActionButtonVariant",
    "notificationsEnabled", "archivedAt", "createdAt", "updatedAt"
FROM "CommandDefinition";

DROP TABLE "CommandDefinition";
ALTER TABLE "new_CommandDefinition" RENAME TO "CommandDefinition";
CREATE INDEX "CommandDefinition_archivedAt_updatedAt_idx" ON "CommandDefinition"("archivedAt", "updatedAt");
CREATE INDEX "CommandDefinition_targetKind_targetAgentId_idx" ON "CommandDefinition"("targetKind", "targetAgentId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
