-- Repository-level definitions applied to every worktree.
CREATE TABLE "CodebaseRepositoryPreparation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "contents" BLOB,
    "contentSha256" TEXT,
    "byteCount" INTEGER,
    "definitionHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CodebaseRepositoryPreparation_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CodebaseRepositoryPreparation_repositoryId_path_key" ON "CodebaseRepositoryPreparation"("repositoryId", "path");
CREATE INDEX "CodebaseRepositoryPreparation_repositoryId_kind_path_idx" ON "CodebaseRepositoryPreparation"("repositoryId", "kind", "path");

CREATE TABLE "WorktreePreparationStatus" (
    "worktreeId" TEXT NOT NULL,
    "preparationId" TEXT NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "message" TEXT,
    "checkedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("worktreeId", "preparationId"),
    CONSTRAINT "WorktreePreparationStatus_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorktreePreparationStatus_preparationId_fkey" FOREIGN KEY ("preparationId") REFERENCES "CodebaseRepositoryPreparation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WorktreePreparationStatus_preparationId_state_idx" ON "WorktreePreparationStatus"("preparationId", "state");
CREATE INDEX "WorktreePreparationStatus_worktreeId_state_idx" ON "WorktreePreparationStatus"("worktreeId", "state");

ALTER TABLE "WorktreeAutoSync" ADD COLUMN "pauseReason" TEXT;
