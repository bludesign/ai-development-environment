ALTER TABLE "Worktree" ADD COLUMN "pullRequestLookupOrigin" TEXT;
ALTER TABLE "Worktree" ADD COLUMN "pullRequestLookupBranch" TEXT;
ALTER TABLE "Worktree" ADD COLUMN "pullRequestLookupAt" DATETIME;

CREATE TABLE "WorktreePullRequest" (
    "worktreeId" TEXT NOT NULL PRIMARY KEY,
    "githubId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "repositoryGithubId" TEXT NOT NULL,
    "repositoryNameWithOwner" TEXT NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "labelsJson" TEXT NOT NULL,
    "jiraKey" TEXT,
    "pipelineStatus" TEXT NOT NULL,
    "pipelinesJson" TEXT NOT NULL,
    "reviewDecision" TEXT NOT NULL,
    "unresolvedReviewThreadCount" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "isDraft" BOOLEAN NOT NULL,
    "mergeable" TEXT NOT NULL,
    "mergeStateStatus" TEXT NOT NULL,
    "autoMergeEnabled" BOOLEAN NOT NULL,
    "viewerCanEnableAutoMerge" BOOLEAN NOT NULL,
    "viewerCanDisableAutoMerge" BOOLEAN NOT NULL,
    "headRefOid" TEXT NOT NULL,
    "headRefName" TEXT NOT NULL,
    "githubCreatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorktreePullRequest_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WorktreePullRequest_githubId_idx" ON "WorktreePullRequest"("githubId");
