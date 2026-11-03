ALTER TABLE "WorktreeAutoMerge" ADD COLUMN "autoSync" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WorktreeAutoMerge" ADD COLUMN "syncStateJson" TEXT;
ALTER TABLE "GitLabMergeOperation" ADD COLUMN "autoSync" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GitLabMergeOperation" ADD COLUMN "syncStateJson" TEXT;
