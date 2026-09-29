export const GITLAB_MERGE_OPERATION_FIELDS = `id state autoMerge worktreeId ticketKey lastError mergeConfirmedAt ticketMovedAt worktreeDeletedAt updatedAt`;

export const GITLAB_MERGE_REQUEST_FIELDS = `id iid projectId projectPath sourceProjectId title description state draft webUrl sourceBranch targetBranch sha
  author { id username name avatarUrl webUrl } reviewers { id username name avatarUrl webUrl }
  labels detailedMergeStatus mergeWhenPipelineSucceeds squashOnMerge hasConflicts blockingDiscussionsResolved createdAt updatedAt mergedAt
  worktreeId worktreeHighlightColor ticketKey approvalState approvalsRequired approvalsLeft unresolvedDiscussionsCount
  headPipeline { id projectId iid ref branch sha source status webUrl createdAt updatedAt startedAt finishedAt duration queuedDuration }
  mergeOperation { ${GITLAB_MERGE_OPERATION_FIELDS} }`;
