CREATE TABLE "GitHubGraphqlCacheTtlOverride" (
    "operation" TEXT NOT NULL PRIMARY KEY,
    "ttlSeconds" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "GitHubGraphqlCacheTtlOverride" (
    "operation",
    "ttlSeconds",
    "updatedAt"
) VALUES (
    'GitHubWorktreePullRequestStatuses',
    60,
    CURRENT_TIMESTAMP
);
