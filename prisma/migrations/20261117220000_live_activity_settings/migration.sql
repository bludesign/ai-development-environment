CREATE TABLE "LiveActivitySettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "includePlans" BOOLEAN NOT NULL DEFAULT true,
    "includeSessions" BOOLEAN NOT NULL DEFAULT true,
    "includeBuilds" BOOLEAN NOT NULL DEFAULT true,
    "includeWorkflows" BOOLEAN NOT NULL DEFAULT true,
    "includeCommands" BOOLEAN NOT NULL DEFAULT true,
    "includeGitHubActions" BOOLEAN NOT NULL DEFAULT true,
    "includeGitLabPipelines" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);
