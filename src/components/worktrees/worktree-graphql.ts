export const PULL_REQUEST_FIELDS =
  "id number title url repositoryGithubId repositoryNameWithOwner repositoryUrl labels jiraKey pipelineStatus pipelineRevision pipelines { id name status url checkSuiteId canRetry retryUnavailableReason jobs { id name status url canRetry retryUnavailableReason steps { number name status } } } reviewDecision unresolvedReviewThreadCount state isDraft mergeable mergeStateStatus autoMergeEnabled viewerCanEnableAutoMerge viewerCanDisableAutoMerge headRefOid headRefName createdAt";

export const WORKTREE_FIELDS = `
  id codebaseId gitDirectory folder relativePath primary branch headSha upstream ahead behind syncState
  baseBranch baseBranchOverride baseAhead baseBehind hasStagedChanges hasUnstagedChanges rebaseInProgress hasConflicts highlightColor availability statusError
  pushStatus
  ticketKey ticketTitle ticketStatus lastCheckedAt missingAt createdAt updatedAt
  tags { id name color createdAt updatedAt }
  activeJob { id agentId kind payload status idempotencyKey result error timeoutSeconds createdAt startedAt finishedAt updatedAt }
  autoSync { worktreeId state conflictWorkflowId conflictWorkflowChoice lastError pauseReason lastSyncedAt updatedAt }
  autoMerge { worktreeId state repositoryNameWithOwner pullRequestNumber mergeMethod commitHeadline commitBody authorEmail deleteWorktree moveTicketToDone ticketKey lastError updatedAt }
  pullRequest { ${PULL_REQUEST_FIELDS} }
  sourceControlRequest {
    provider id number title url isDraft headRefName headRefOid createdAt
    ... on GitLabMergeRequest { projectId detailedMergeStatus }
  }
  gitLabPipelines {
    id projectId iid ref branch sha source status webUrl
    mergeRequests { projectId iid title webUrl sourceBranch }
    worktreeId worktreeHighlightColor startedAt createdAt updatedAt finishedAt duration queuedDuration
  }
  latestBuild {
    id status action destinationType destination outOfDate createdAt
    artifacts { id kind }
  }
`;

export const CODEBASE_FIELDS = `
  id folder observedOrigin branch headSha upstream ahead behind syncState availability statusError
  defaultBranch localBranches remoteBranches lastCheckedAt lastFetchedAt lastFetchAttemptAt lastFetchError createdAt updatedAt
`;

export const INSPECT_WORKTREE_MUTATION = `mutation InspectWorktree($id: ID!, $requestId: ID!) {
  inspectWorktree(id: $id, requestId: $requestId) {
    commits { sha subject authorName authoredAt additions deletions }
    changes { path previousPath changeType staged unstaged untracked conflicted stagedAdditions stagedDeletions unstagedAdditions unstagedDeletions }
    branchChanges { path previousPath changeType additions deletions binary image }
    commitsTruncated changesTruncated branchChangesTruncated commitSigningEnabled
  }
}`;

export const INSPECT_WORKTREE_DIFF_MUTATION = `mutation InspectWorktreeDiff($input: WorktreeDiffInput!) {
  inspectWorktreeDiff(input: $input) {
    files { path previousPath changeType additions deletions binary image }
    patch image binary truncated beforeAvailable afterAvailable
  }
}`;
