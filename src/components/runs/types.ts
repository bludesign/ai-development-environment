export type RunWorktreeRef = {
  id: string;
  folder: string;
  branch: string | null;
  highlightColor: string | null;
};

export type RunAttachmentView = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  downloadPath: string;
  createdAt: string;
};

export type RunInputView = {
  id: string;
  sequence: number;
  kind: string;
  prompt: string;
  attachments: RunAttachmentView[];
  createdAt: string;
};

export type RunLinkView = {
  id: string;
  kind: "PLAN" | "SESSION";
  displayNumber: number;
  status: string;
  provider: string;
  followUpMode?: string | null;
};

export type AgentRunView = RunLinkView & {
  phase: string;
  origin: "MANAGED" | "IMPORTED";
  providerVersion: string | null;
  worktreeId: string | null;
  agentId: string | null;
  worktree: RunWorktreeRef | null;
  jiraIssueKey: string | null;
  jiraSummary: string | null;
  repositoryName: string;
  branch: string | null;
  model: string;
  effort: string | null;
  webSearchEnabled: boolean;
  initialPrompt: string;
  finalOutput: string | null;
  error: string | null;
  estimatedCost: number | null;
  pricingSource: string | null;
  pricingUpdatedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCallCount: number;
  sourcePlanId: string | null;
  sourcePlanNumber: number | null;
  playedAt: string | null;
  playedSessionNumber: number | null;
  sourcePlan: RunLinkView | null;
  playedSession: RunLinkView | null;
  parentRunId: string | null;
  parentRunNumber: number | null;
  parentRun: RunLinkView | null;
  followUps: RunLinkView[];
  attempts: Array<{
    id: string;
    generation: number;
    nativeId: string | null;
    status: string;
    resumeStrategy: string | null;
    startedAt: string;
    finishedAt: string | null;
    supersededAt: string | null;
  }>;
  inputs: RunInputView[];
  modelUsage: Array<{
    id: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCost: number | null;
    superseded: boolean;
  }>;
  toolCalls: Array<{
    id: string;
    sequence: number;
    name: string;
    status: string;
    input: unknown;
    output: unknown;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
    supersededAt: string | null;
  }>;
  questionBatches: RunQuestionBatchView[];
  checkpoints: Array<{
    id: string;
    kind: string;
    headSha: string | null;
    branch: string | null;
    upstreamSha: string | null;
    indexTree: string | null;
    worktreeTree: string | null;
    refName: string | null;
    diffSummary: string | null;
    diffPatch: string | null;
    stashRef: string | null;
    createdAt: string;
  }>;
  archivedAt: string | null;
  nativeArchivedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RunEventView = {
  id: string;
  runId: string;
  attemptId: string | null;
  sequence: number;
  type: string;
  summary: string;
  detailMarkdown: string | null;
  raw: unknown;
  createdAt: string;
  supersededAt: string | null;
};

export type RunQuestionBatchView = {
  id: string;
  nativeRequestId: string | null;
  status: string;
  questions: Array<{
    id: string;
    position: number;
    header: string | null;
    prompt: string;
    multiSelect: boolean;
    allowCustom: boolean;
    options: Array<{
      id: string;
      position: number;
      label: string;
      description: string | null;
    }>;
  }>;
  answerRevisions: Array<{
    id: string;
    revision: number;
    answers: unknown;
    createdAt: string;
    supersededAt: string | null;
    replacementAttemptId: string | null;
  }>;
  createdAt: string;
  answeredAt: string | null;
  supersededAt: string | null;
  revisionPreparedAt: string | null;
  rollbackPatch: string | null;
  pushedCommitWarning: string | null;
  checkpoint: AgentRunView["checkpoints"][number] | null;
};

export type RunDraftView = {
  id: string;
  kind: "PLAN" | "SESSION";
  worktreeId: string | null;
  agentId: string | null;
  worktree: RunWorktreeRef | null;
  jiraIssueKey: string | null;
  jiraSummary: string | null;
  provider: string;
  model: string;
  effort: string | null;
  webSearchEnabled: boolean;
  prompt: string;
  attachments: RunAttachmentView[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
