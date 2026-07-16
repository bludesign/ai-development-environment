-- Retain at most one existing active operation per codebase before enforcing
-- the invariant for newly scheduled work.
UPDATE "AgentJob"
SET
    "status" = 'CANCELLED',
    "error" = COALESCE("error", 'Superseded by another active codebase operation'),
    "finishedAt" = CURRENT_TIMESTAMP
WHERE
    "codebaseId" IS NOT NULL
    AND "status" IN ('QUEUED', 'RUNNING')
    AND "id" IN (
        SELECT "id"
        FROM (
            SELECT
                "id",
                ROW_NUMBER() OVER (
                    PARTITION BY "codebaseId"
                    ORDER BY
                        CASE WHEN "status" = 'RUNNING' THEN 0 ELSE 1 END,
                        "createdAt" ASC
                ) AS "position"
            FROM "AgentJob"
            WHERE
                "codebaseId" IS NOT NULL
                AND "status" IN ('QUEUED', 'RUNNING')
        )
        WHERE "position" > 1
    );

CREATE UNIQUE INDEX "AgentJob_codebaseId_active_key"
ON "AgentJob"("codebaseId")
WHERE "codebaseId" IS NOT NULL AND "status" IN ('QUEUED', 'RUNNING');
