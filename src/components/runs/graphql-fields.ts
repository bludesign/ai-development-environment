export const RUN_LINK_FIELDS = `
  id kind displayNumber status provider followUpMode
`;

export const RUN_LIST_FIELDS = `
  id kind displayNumber status phase origin provider providerVersion
  worktreeId agentId worktree { id folder branch highlightColor }
  jiraIssueKey jiraSummary repositoryName branch model effort webSearchEnabled
  initialPrompt finalOutput estimatedCost pricingSource sourcePlanId sourcePlanNumber
  playedAt playedSessionNumber
  sourcePlan { ${RUN_LINK_FIELDS} }
  playedSession { ${RUN_LINK_FIELDS} }
  archivedAt nativeArchivedAt startedAt finishedAt createdAt updatedAt
`;

export const RUN_DETAIL_FIELDS = `
  ${RUN_LIST_FIELDS}
  finalOutput error pricingUpdatedAt catalogCost inputTokens outputTokens reasoningTokens
  cacheReadTokens cacheWriteTokens toolCallCount parentRunId parentRunNumber
  parentRun { ${RUN_LINK_FIELDS} }
  followUps { ${RUN_LINK_FIELDS} }
  attempts { id generation nativeId status resumeStrategy startedAt finishedAt supersededAt }
  inputs {
    id sequence kind prompt createdAt
    attachments { id filename contentType size sha256 downloadPath createdAt }
  }
  modelUsage {
    id model inputTokens outputTokens reasoningTokens cacheReadTokens
    cacheWriteTokens estimatedCost catalogCost superseded
  }
  toolCalls {
    id sequence name status input output error startedAt finishedAt supersededAt
  }
  questionBatches {
    id nativeRequestId status createdAt answeredAt supersededAt
    revisionPreparedAt rollbackPatch pushedCommitWarning
    questions {
      id position header prompt multiSelect allowCustom
      options { id position label description }
    }
    answerRevisions {
      id revision answers createdAt supersededAt replacementAttemptId
    }
    checkpoint { id kind headSha branch upstreamSha indexTree worktreeTree refName diffSummary diffPatch stashRef createdAt }
  }
  checkpoints {
    id kind headSha branch upstreamSha indexTree worktreeTree refName
    diffSummary diffPatch stashRef createdAt
  }
`;

export const RUN_EVENT_FIELDS = `
  id runId attemptId sequence type summary detailMarkdown raw createdAt supersededAt
`;

export const RUN_DRAFT_FIELDS = `
  id kind worktreeId agentId worktree { id folder branch highlightColor }
  jiraIssueKey jiraSummary provider model effort webSearchEnabled prompt
  attachments { id filename contentType size sha256 downloadPath createdAt }
  archivedAt createdAt updatedAt
`;
