ALTER TABLE "Workflow" ADD COLUMN "overlapScope" TEXT NOT NULL DEFAULT 'WORKTREE';

-- New workflows count their overlap per worktree, which is what a worktree
-- trigger implies. Existing workflows keep the behavior they ran with: the
-- overlap policy counted every run of the workflow, everywhere. Worktree
-- reservations were already meant to be per worktree, so those move to the
-- new scope instead of staying serialized across unrelated worktrees.
UPDATE "Workflow" SET "overlapScope" = 'GLOBAL' WHERE "exclusiveWorktree" = 0;
