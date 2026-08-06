-- Preserve the immutable run snapshot for command jobs that were already
-- queued or running when the Git-blocking column was introduced.
UPDATE "AgentJob"
SET "blocksGitOperations" = true
WHERE "kind" = 'command.run'
  AND EXISTS (
    SELECT 1
    FROM "CommandRunAttempt" AS "attempt"
    INNER JOIN "CommandRun" AS "run" ON "run"."id" = "attempt"."runId"
    WHERE "attempt"."agentJobId" = "AgentJob"."id"
      AND "run"."snapshotBlocksGitOperations" = true
  );
