CREATE TABLE "GitLabMergeOperation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "instanceUrl" TEXT NOT NULL, "projectId" TEXT NOT NULL, "iid" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PREPARING',
  "sourceProjectId" TEXT, "sourceOrigin" TEXT, "branch" TEXT NOT NULL, "sha" TEXT NOT NULL,
  "autoMerge" BOOLEAN NOT NULL DEFAULT false, "squash" BOOLEAN NOT NULL DEFAULT false,
  "removeSourceBranch" BOOLEAN NOT NULL DEFAULT false,
  "mergeCommitMessage" TEXT, "squashCommitMessage" TEXT,
  "worktreeId" TEXT, "worktreeFolder" TEXT,
  "deleteWorktree" BOOLEAN NOT NULL DEFAULT false, "moveTicketToDone" BOOLEAN NOT NULL DEFAULT false,
  "ticketKey" TEXT, "mergeConfirmedAt" DATETIME, "ticketMovedAt" DATETIME,
  "worktreeDeletedAt" DATETIME, "deleteJobId" TEXT, "deleteRequestId" TEXT, "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "GitLabMergeOperation_instanceUrl_projectId_iid_key" ON "GitLabMergeOperation"("instanceUrl", "projectId", "iid");
CREATE INDEX "GitLabMergeOperation_state_updatedAt_idx" ON "GitLabMergeOperation"("state", "updatedAt");
CREATE INDEX "GitLabMergeOperation_worktreeId_idx" ON "GitLabMergeOperation"("worktreeId");
