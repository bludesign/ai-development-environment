-- CreateTable
CREATE TABLE "GitHubSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "apiToken" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GitHubRepository" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "githubId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameWithOwner" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "jiraKeyRegex" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GitHubRepository_githubId_key" ON "GitHubRepository"("githubId");
CREATE UNIQUE INDEX "GitHubRepository_nameWithOwner_key" ON "GitHubRepository"("nameWithOwner");
CREATE INDEX "GitHubRepository_nameWithOwner_idx" ON "GitHubRepository"("nameWithOwner");
