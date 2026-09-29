ALTER TABLE "GitHubSettings" ADD COLUMN "defaultMergeMethod" TEXT NOT NULL DEFAULT 'SQUASH';
ALTER TABLE "GitHubSettings" ADD COLUMN "emptyMergeCommitDescription" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GitHubSettings" ADD COLUMN "defaultMoveTicketToDone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GitHubSettings" ADD COLUMN "defaultDeleteWorktree" BOOLEAN NOT NULL DEFAULT false;
