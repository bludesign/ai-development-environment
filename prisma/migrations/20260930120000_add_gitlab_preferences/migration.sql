ALTER TABLE "GitLabSettings"
ADD COLUMN "memberProjectsOnly" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "GitLabSettings"
ADD COLUMN "defaultSquash" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "GitLabSettings"
ADD COLUMN "defaultMoveTicketToDone" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "GitLabSettings"
ADD COLUMN "defaultDeleteWorktree" BOOLEAN NOT NULL DEFAULT false;
