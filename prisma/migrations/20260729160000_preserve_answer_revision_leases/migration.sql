ALTER TABLE "WorktreeRunLease" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'RUN';
ALTER TABLE "WorktreeRunLease" ADD COLUMN "reservationKey" TEXT;

CREATE INDEX "WorktreeRunLease_worktreeId_purpose_acquiredAt_idx"
ON "WorktreeRunLease"("worktreeId", "purpose", "acquiredAt");
