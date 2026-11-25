CREATE TABLE "WorktreeAutoBuild" (
    "worktreeId" TEXT NOT NULL PRIMARY KEY,
    "generation" TEXT NOT NULL,
    "configurationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "destinationType" TEXT NOT NULL,
    "lastHandledHeadSha" TEXT,
    "lastQueuedHeadSha" TEXT,
    "lastQueuedBuildId" TEXT,
    "lastError" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorktreeAutoBuild_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorktreeAutoBuild_lastQueuedBuildId_fkey" FOREIGN KEY ("lastQueuedBuildId") REFERENCES "Build" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "WorktreeAutoBuild_lastQueuedBuildId_idx" ON "WorktreeAutoBuild"("lastQueuedBuildId");
