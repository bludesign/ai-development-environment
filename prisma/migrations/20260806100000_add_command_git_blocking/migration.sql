ALTER TABLE "CommandDefinition"
ADD COLUMN "blocksGitOperations" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CommandRun"
ADD COLUMN "snapshotBlocksGitOperations" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AgentJob"
ADD COLUMN "blocksGitOperations" BOOLEAN NOT NULL DEFAULT false;

-- Exclusive commands always reserve Git access. Existing non-exclusive and
-- excluded commands adopt the new permissive default.
UPDATE "CommandDefinition"
SET "blocksGitOperations" = true
WHERE "concurrency" = 'EXCLUSIVE';

UPDATE "CommandRun"
SET "snapshotBlocksGitOperations" = true
WHERE "snapshotConcurrency" = 'EXCLUSIVE';

DROP TRIGGER IF EXISTS "AgentJob_codebase_command_guard_insert";
DROP TRIGGER IF EXISTS "AgentJob_codebase_command_guard_update";

-- A command participates in the cross-kind codebase guard only when its
-- immutable run snapshot requested it. Non-command repository work continues
-- to serialize with other non-command work through the partial unique index.
CREATE TRIGGER "AgentJob_codebase_command_guard_insert"
BEFORE INSERT ON "AgentJob"
WHEN NEW."codebaseId" IS NOT NULL
  AND NEW."status" IN ('QUEUED', 'RUNNING')
  AND NEW."kind" NOT LIKE 'ios.%'
  AND EXISTS (
    SELECT 1
    FROM "AgentJob" AS "active"
    WHERE "active"."codebaseId" = NEW."codebaseId"
      AND "active"."status" IN ('QUEUED', 'RUNNING')
      AND "active"."kind" NOT LIKE 'ios.%'
      AND (
        (
          NEW."kind" = 'command.run'
          AND NEW."blocksGitOperations" = true
          AND "active"."kind" <> 'command.run'
        )
        OR
        (
          NEW."kind" <> 'command.run'
          AND "active"."kind" = 'command.run'
          AND "active"."blocksGitOperations" = true
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'AgentJob_codebaseId_active_key');
END;

CREATE TRIGGER "AgentJob_codebase_command_guard_update"
BEFORE UPDATE OF "codebaseId", "kind", "status", "blocksGitOperations" ON "AgentJob"
WHEN NEW."codebaseId" IS NOT NULL
  AND NEW."status" IN ('QUEUED', 'RUNNING')
  AND NEW."kind" NOT LIKE 'ios.%'
  AND EXISTS (
    SELECT 1
    FROM "AgentJob" AS "active"
    WHERE "active"."id" <> NEW."id"
      AND "active"."codebaseId" = NEW."codebaseId"
      AND "active"."status" IN ('QUEUED', 'RUNNING')
      AND "active"."kind" NOT LIKE 'ios.%'
      AND (
        (
          NEW."kind" = 'command.run'
          AND NEW."blocksGitOperations" = true
          AND "active"."kind" <> 'command.run'
        )
        OR
        (
          NEW."kind" <> 'command.run'
          AND "active"."kind" = 'command.run'
          AND "active"."blocksGitOperations" = true
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'AgentJob_codebaseId_active_key');
END;
