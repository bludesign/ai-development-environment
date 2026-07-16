-- CreateTable
CREATE TABLE "GitHubAppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "apiBaseUrl" TEXT NOT NULL DEFAULT 'https://api.github.com',
    "graphqlUrl" TEXT NOT NULL DEFAULT 'https://api.github.com/graphql',
    "keyFingerprint" TEXT NOT NULL,
    "appSlug" TEXT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "repositorySelection" TEXT NOT NULL,
    "actionsPermission" TEXT NOT NULL,
    "verifiedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GitHubAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeId" TEXT NOT NULL DEFAULT 'default',
    "actor" TEXT NOT NULL,
    "ipAddress" TEXT,
    "operation" TEXT NOT NULL,
    "repositoryId" TEXT,
    "checkSuiteId" TEXT,
    "githubRequestId" TEXT,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "GitHubAuditEvent_operation_createdAt_idx" ON "GitHubAuditEvent"("operation", "createdAt");

-- CreateIndex
CREATE INDEX "GitHubAuditEvent_repositoryId_createdAt_idx" ON "GitHubAuditEvent"("repositoryId", "createdAt");
