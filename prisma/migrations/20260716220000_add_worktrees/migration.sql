ALTER TABLE "AgentJob" ADD COLUMN "worktreeId" TEXT;
ALTER TABLE "CodebaseRepository" ADD COLUMN "jiraBranchRegex" TEXT;
ALTER TABLE "Codebase" ADD COLUMN "defaultBranch" TEXT;
ALTER TABLE "Codebase" ADD COLUMN "remoteBranchesJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Codebase" ADD COLUMN "lastFetchAttemptAt" DATETIME;
ALTER TABLE "Codebase" ADD COLUMN "lastFetchError" TEXT;
ALTER TABLE "CodebaseSettings" ADD COLUMN "fetchIntervalSeconds" INTEGER NOT NULL DEFAULT 300;
ALTER TABLE "CodebaseSettings" ADD COLUMN "defaultJiraBranchRegex" TEXT NOT NULL DEFAULT '\b([A-Z][A-Z0-9_]*-\d+)\b';

CREATE TABLE "Worktree" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "codebaseId" TEXT NOT NULL,
    "gitDirectory" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "branch" TEXT,
    "headSha" TEXT,
    "upstream" TEXT,
    "ahead" INTEGER,
    "behind" INTEGER,
    "syncState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "baseBranchOverride" TEXT,
    "baseAhead" INTEGER,
    "baseBehind" INTEGER,
    "highlightColor" TEXT,
    "availability" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "statusError" TEXT,
    "lastCheckedAt" DATETIME,
    "missingAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Worktree_codebaseId_fkey" FOREIGN KEY ("codebaseId") REFERENCES "Codebase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorktreeTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "WorktreeTagAssignment" (
    "worktreeId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    PRIMARY KEY ("worktreeId", "tagId"),
    CONSTRAINT "WorktreeTagAssignment_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorktreeTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "WorktreeTag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorktreeSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "editorVariant" TEXT NOT NULL DEFAULT 'CODE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "AgentJob_worktreeId_status_createdAt_idx" ON "AgentJob"("worktreeId", "status", "createdAt");
CREATE INDEX "Worktree_codebaseId_missingAt_idx" ON "Worktree"("codebaseId", "missingAt");
CREATE INDEX "Worktree_missingAt_idx" ON "Worktree"("missingAt");
CREATE UNIQUE INDEX "Worktree_codebaseId_gitDirectory_key" ON "Worktree"("codebaseId", "gitDirectory");
CREATE UNIQUE INDEX "WorktreeTag_name_key" ON "WorktreeTag"("name");
CREATE UNIQUE INDEX "WorktreeTag_name_nocase_key" ON "WorktreeTag"(lower("name"));
CREATE INDEX "WorktreeTag_name_idx" ON "WorktreeTag"("name");
CREATE INDEX "WorktreeTagAssignment_tagId_idx" ON "WorktreeTagAssignment"("tagId");
