-- Add the per-project destination used when Auto Merge completes.
ALTER TABLE "JiraProject" ADD COLUMN "doneStatusId" TEXT;

-- Persist Auto Sync independently of the browser session.
CREATE TABLE "WorktreeAutoSync" (
    "worktreeId" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "branch" TEXT NOT NULL,
    "conflictWorkflowId" TEXT,
    "conflictWorkflowChoice" TEXT,
    "activeJobId" TEXT,
    "workflowRunId" TEXT,
    "lastError" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorktreeAutoSync_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorktreeAutoSync_conflictWorkflowId_fkey" FOREIGN KEY ("conflictWorkflowId") REFERENCES "Workflow" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "WorktreeAutoSync_state_updatedAt_idx" ON "WorktreeAutoSync"("state", "updatedAt");
CREATE INDEX "WorktreeAutoSync_conflictWorkflowId_idx" ON "WorktreeAutoSync"("conflictWorkflowId");

-- Persist the native GitHub Auto Merge request and its post-merge cleanup.
CREATE TABLE "WorktreeAutoMerge" (
    "worktreeId" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "repositoryNameWithOwner" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "branch" TEXT NOT NULL,
    "mergeMethod" TEXT NOT NULL,
    "commitHeadline" TEXT NOT NULL,
    "commitBody" TEXT NOT NULL DEFAULT '',
    "authorEmail" TEXT,
    "deleteWorktree" BOOLEAN NOT NULL DEFAULT false,
    "moveTicketToDone" BOOLEAN NOT NULL DEFAULT false,
    "ticketKey" TEXT,
    "ticketMovedAt" DATETIME,
    "deleteJobId" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorktreeAutoMerge_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WorktreeAutoMerge_state_updatedAt_idx" ON "WorktreeAutoMerge"("state", "updatedAt");
CREATE INDEX "WorktreeAutoMerge_repositoryNameWithOwner_pullRequestNumber_idx" ON "WorktreeAutoMerge"("repositoryNameWithOwner", "pullRequestNumber");
