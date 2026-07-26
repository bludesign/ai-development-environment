import type { PrismaClient } from "@/generated/prisma/client";

export type ActionCenterIndexCursor = {
  priority: number;
  updatedAt: string;
  key: string;
};

export type ActionCenterIndexRow = {
  resourceKind: string;
  resourceId: string;
  reason: string;
  key: string;
  updatedAt: string;
};

type ActionCenterCountRow = {
  totalCount: number | bigint;
  needsAttentionCount: number | bigint;
};

const CANDIDATES_SQL = `
  WITH agent_candidates AS (
    SELECT
      run.kind AS resourceKind,
      run.id AS resourceId,
      run.kind || ':' || run.id AS key,
      CASE
        WHEN run.status = 'FAILED' THEN 'FAILED'
        WHEN EXISTS (
          SELECT 1
          FROM RunQuestionBatch AS batch
          WHERE batch.runId = run.id AND batch.status = 'PENDING'
        ) THEN 'QUESTION'
        WHEN substr(run.phase, -7) = '_FAILED'
          OR run.phase = 'IMPORTED_ACTIVE_COLLISION' THEN 'BLOCKED'
        ELSE 'ACTIVE'
      END AS reason,
      strftime('%Y-%m-%dT%H:%M:%fZ', run.updatedAt) AS updatedAt,
      CASE
        WHEN run.status = 'FAILED' THEN
          run.kind || ':' || run.id || ':0:' ||
          strftime(
            '%Y-%m-%dT%H:%M:%fZ',
            COALESCE(run.finishedAt, run.updatedAt)
          )
        ELSE NULL
      END AS failureFingerprint
    FROM AgentRun AS run
    WHERE run.archivedAt IS NULL
      AND run.kind IN ('PLAN', 'SESSION')
      AND run.status IN ('IN_PROGRESS', 'PAUSED', 'FAILED')
  ),
  workflow_candidates AS (
    SELECT
      'WORKFLOW' AS resourceKind,
      run.id AS resourceId,
      'WORKFLOW:' || run.id AS key,
      CASE
        WHEN run.status <> 'FAILED' AND EXISTS (
          SELECT 1
          FROM WorkflowStepAttempt AS attempt
          INNER JOIN RunQuestionBatch AS batch
            ON batch.workflowStepAttemptId = attempt.id
          WHERE attempt.runId = run.id
            AND attempt.supersededAt IS NULL
            AND batch.status = 'PENDING'
        ) THEN 'QUESTION'
        WHEN run.status = 'BLOCKED' THEN 'BLOCKED'
        WHEN run.status = 'FAILED' THEN 'FAILED'
        ELSE 'ACTIVE'
      END AS reason,
      strftime('%Y-%m-%dT%H:%M:%fZ', run.updatedAt) AS updatedAt,
      CASE
        WHEN run.status = 'FAILED' THEN
          'WORKFLOW:' || run.id || ':' || run.generation || ':' ||
          strftime(
            '%Y-%m-%dT%H:%M:%fZ',
            COALESCE(run.finishedAt, run.updatedAt)
          )
        ELSE NULL
      END AS failureFingerprint
    FROM WorkflowRun AS run
    WHERE run.archivedAt IS NULL
      AND run.status IN (
        'QUEUED',
        'RUNNING',
        'PAUSING',
        'PAUSED',
        'WAITING',
        'BLOCKED',
        'FAILED'
      )
  ),
  build_status_candidates AS (
    SELECT
      'BUILD' AS resourceKind,
      build.id AS resourceId,
      'BUILD:' || build.id AS key,
      CASE WHEN build.status = 'FAILED' THEN 'FAILED' ELSE 'ACTIVE' END AS reason,
      strftime('%Y-%m-%dT%H:%M:%fZ', build.updatedAt) AS updatedAt,
      CASE
        WHEN build.status = 'FAILED' THEN
          'BUILD:' || build.id || ':0:' ||
          strftime(
            '%Y-%m-%dT%H:%M:%fZ',
            COALESCE(build.finishedAt, build.updatedAt)
          )
        ELSE NULL
      END AS failureFingerprint
    FROM Build AS build
    WHERE build.status IN ('QUEUED', 'PREPARING', 'RUNNING', 'FAILED')
  ),
  ranked_builds AS (
    SELECT
      build.*,
      ROW_NUMBER() OVER (
        PARTITION BY CASE
          WHEN build.worktreeId IS NOT NULL
            AND build.configurationId IS NOT NULL THEN
            build.worktreeId || ':' || build.configurationId || ':' ||
            build.destinationType
          ELSE build.id
        END
        ORDER BY julianday(build.createdAt) DESC, build.id DESC
      ) AS targetRank
    FROM Build AS build
  ),
  unrun_build_candidates AS (
    SELECT
      'BUILD' AS resourceKind,
      build.id AS resourceId,
      'BUILD:' || build.id AS key,
      'UNRUN_BUILD' AS reason,
      strftime('%Y-%m-%dT%H:%M:%fZ', build.updatedAt) AS updatedAt,
      NULL AS failureFingerprint
    FROM ranked_builds AS build
    INNER JOIN Worktree AS worktree ON worktree.id = build.worktreeId
    WHERE build.targetRank = 1
      AND build.status = 'SUCCEEDED'
      AND worktree.missingAt IS NULL
      AND worktree.availability = 'AVAILABLE'
      AND EXISTS (
        SELECT 1
        FROM BuildArtifact AS artifact
        WHERE artifact.buildId = build.id AND artifact.kind = 'RUNNABLE_APP'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM BuildDeployment AS deployment
        WHERE deployment.buildId = build.id
      )
  ),
  candidates AS (
    SELECT * FROM agent_candidates
    UNION ALL
    SELECT * FROM workflow_candidates
    UNION ALL
    SELECT * FROM build_status_candidates
    UNION ALL
    SELECT * FROM unrun_build_candidates
  ),
  visible AS (
    SELECT
      candidate.*,
      CASE candidate.reason
        WHEN 'QUESTION' THEN 0
        WHEN 'BLOCKED' THEN 1
        WHEN 'FAILED' THEN 2
        WHEN 'UNRUN_BUILD' THEN 3
        ELSE 4
      END AS priority
    FROM candidates AS candidate
    WHERE candidate.failureFingerprint IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM ActionCenterAcknowledgement AS acknowledgement
        WHERE acknowledgement.resourceKind = candidate.resourceKind
          AND acknowledgement.resourceId = candidate.resourceId
          AND acknowledgement.failureFingerprint = candidate.failureFingerprint
      )
  )
`;

function countValue(value: number | bigint | undefined): number {
  return Number(value ?? 0);
}

export async function queryActionCenterIndex(
  prisma: PrismaClient,
  input: { first: number; cursor: ActionCenterIndexCursor | null },
) {
  const cursor = input.cursor;
  const [rows, countRows] = await Promise.all([
    prisma.$queryRawUnsafe<ActionCenterIndexRow[]>(
      `${CANDIDATES_SQL}
       SELECT resourceKind, resourceId, reason, key, updatedAt
       FROM visible
       WHERE ? = 0
         OR priority > ?
         OR (
           priority = ?
           AND (updatedAt < ? OR (updatedAt = ? AND key > ?))
         )
       ORDER BY priority ASC, updatedAt DESC, key ASC
       LIMIT ?`,
      cursor ? 1 : 0,
      cursor?.priority ?? 0,
      cursor?.priority ?? 0,
      cursor?.updatedAt ?? "",
      cursor?.updatedAt ?? "",
      cursor?.key ?? "",
      input.first + 1,
    ),
    prisma.$queryRawUnsafe<ActionCenterCountRow[]>(
      `${CANDIDATES_SQL}
       SELECT
         COUNT(*) AS totalCount,
         COALESCE(
           SUM(CASE WHEN reason <> 'ACTIVE' THEN 1 ELSE 0 END),
           0
         ) AS needsAttentionCount
       FROM visible`,
    ),
  ]);
  const counts = countRows[0];
  const totalCount = countValue(counts?.totalCount);
  const needsAttentionCount = countValue(counts?.needsAttentionCount);

  return {
    rows,
    totalCount,
    needsAttentionCount,
    activeCount: totalCount - needsAttentionCount,
  };
}
