ALTER TABLE "ActionCenterSettings" ADD COLUMN "hideUnapprovedRequestsInSidebar" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ActionCenterSettings" ADD COLUMN "hideRunningPipelineRequestsInSidebar" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WorktreeSettings" ADD COLUMN "autoAssignHighlightColor" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WorktreeSettings" ADD COLUMN "highlightColorMode" TEXT NOT NULL DEFAULT 'SPREAD';
ALTER TABLE "Worktree" ADD COLUMN "initialHighlightApplied" BOOLEAN NOT NULL DEFAULT false;
-- Existing worktrees must remain unchanged if an old creation result is replayed.
UPDATE "Worktree" SET "initialHighlightApplied" = true;
