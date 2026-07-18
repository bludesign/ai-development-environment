DROP INDEX IF EXISTS "AgentJob_codebaseId_active_key";

-- Git and worktree mutations still keep their single-active-job guard. iOS jobs are
-- queueable and are serialized by the control agent's repository coordinator.
CREATE UNIQUE INDEX "AgentJob_codebaseId_active_key"
ON "AgentJob"("codebaseId")
WHERE "codebaseId" IS NOT NULL
  AND "status" IN ('QUEUED', 'RUNNING')
  AND "kind" NOT LIKE 'ios.%';
