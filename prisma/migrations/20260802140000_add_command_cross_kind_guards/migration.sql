-- Commands may share a codebase with other commands, but never with Git or
-- worktree work. The partial unique index cannot express that cross-kind rule,
-- so triggers enforce it atomically in both insertion orders. iOS jobs retain
-- their existing exemption from the codebase slot.
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
        (NEW."kind" = 'command.run' AND "active"."kind" <> 'command.run')
        OR
        (NEW."kind" <> 'command.run' AND "active"."kind" = 'command.run')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'AgentJob_codebaseId_active_key');
END;

CREATE TRIGGER "AgentJob_codebase_command_guard_update"
BEFORE UPDATE OF "codebaseId", "kind", "status" ON "AgentJob"
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
        (NEW."kind" = 'command.run' AND "active"."kind" <> 'command.run')
        OR
        (NEW."kind" <> 'command.run' AND "active"."kind" = 'command.run')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'AgentJob_codebaseId_active_key');
END;
