export type SourceControlProvider = "GITHUB" | "GITLAB";

export type GitLabRequestSource =
  | "GITLAB_API"
  | "GITLAB_SETTINGS"
  | "MERGE_REQUESTS_PAGE"
  | "MERGE_REQUEST_DETAILS"
  | "PIPELINES_PAGE"
  | "COMMENTS_PAGE"
  | "WORKTREES"
  | "WORKFLOW_AUTOMATION"
  | "AUTO_RETRY"
  | "CACHE_MANAGEMENT"
  | "WEBHOOK_MANAGEMENT";

export type GitLabCallSource = "LIVE" | "CACHE" | "ERROR";
export type GitLabMergeRequestScope =
  "MINE" | "REVIEW_REQUESTED" | "PROJECT" | "ALL";
export type GitLabMergeRequestState = "OPENED" | "CLOSED" | "MERGED" | "ALL";
export type GitLabReviewOutcome = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export type GitLabUserView = {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  webUrl: string;
};

export type GitLabSettingsView = {
  configured: boolean;
  tokenConfigured: boolean;
  baseUrl: string | null;
  version: string | null;
  revision: string | null;
  viewer: GitLabUserView | null;
  pipelinePollIntervalSeconds: number;
  cacheTtlSeconds: number;
  verifiedAt: string | null;
  updatedAt: string;
};

export type SourceControlIntegrationStateView = {
  github: { configured: boolean; webhooksEnabled: boolean };
  gitlab: {
    configured: boolean;
    webhooksEnabled: boolean;
    baseUrl: string | null;
  };
};

export type GitLabProjectView = {
  id: string;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  defaultBranch: string | null;
  visibility: string;
  enabled: boolean;
  webhookId: string | null;
  webhookState: string;
  webhookError: string | null;
  webhookConfiguredAt: string | null;
  webhookLastReceivedAt: string | null;
};

export type GitLabProjectCandidateView = Omit<
  GitLabProjectView,
  | "enabled"
  | "webhookId"
  | "webhookState"
  | "webhookError"
  | "webhookConfiguredAt"
  | "webhookLastReceivedAt"
> & { alreadyManaged: boolean };

export type GitLabPipelineStatus =
  | "CREATED"
  | "WAITING_FOR_RESOURCE"
  | "PREPARING"
  | "PENDING"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELED"
  | "SKIPPED"
  | "MANUAL"
  | "SCHEDULED"
  | "UNKNOWN";

export type GitLabPipelineMergeRequestView = {
  projectId: string;
  iid: number;
  title: string;
  webUrl: string;
  sourceBranch: string;
};

export type GitLabPipelineView = {
  id: string;
  projectId: string;
  iid: string | null;
  ref: string;
  branch: string;
  sha: string;
  source: string;
  status: GitLabPipelineStatus;
  webUrl: string;
  mergeRequests: GitLabPipelineMergeRequestView[];
  worktreeId: string | null;
  worktreeHighlightColor: string | null;
  startedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  duration: number | null;
  queuedDuration: number | null;
};

export type GitLabJobView = {
  id: string;
  pipelineId: string;
  name: string;
  stage: string;
  status: GitLabPipelineStatus;
  ref: string;
  webUrl: string;
  allowFailure: boolean;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  duration: number | null;
  queuedDuration: number | null;
  retried: boolean;
};

export type GitLabDiscussionNoteView = {
  id: string;
  body: string;
  author: GitLabUserView;
  createdAt: string;
  updatedAt: string;
  system: boolean;
  resolvable: boolean;
  resolved: boolean;
  resolvedBy: GitLabUserView | null;
};

export type GitLabDiscussionView = {
  id: string;
  individualNote: boolean;
  notes: GitLabDiscussionNoteView[];
};

export type GitLabMergeRequestView = {
  id: string;
  iid: number;
  projectId: string;
  title: string;
  description: string;
  state: string;
  draft: boolean;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  sha: string;
  author: GitLabUserView;
  reviewers: GitLabUserView[];
  labels: string[];
  detailedMergeStatus: string;
  mergeWhenPipelineSucceeds: boolean;
  squashOnMerge: boolean;
  hasConflicts: boolean;
  blockingDiscussionsResolved: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
};

export type GitLabMergeRequestDetailView = GitLabMergeRequestView & {
  changesCount: string | null;
  commitsCount: number;
  discussions: GitLabDiscussionView[];
  pipelines: GitLabPipelineView[];
};

export type GitLabCacheEntryView = {
  id: string;
  operation: string;
  endpoint: string;
  fetchedAt: string;
  stale: boolean;
};

export type GitLabCacheEntryDetailView = GitLabCacheEntryView & {
  request: unknown;
  response: unknown;
};

export type GitLabApiCallView = {
  id: string;
  method: string;
  endpoint: string;
  operation: string;
  requestSource: string;
  requestSummary: string;
  source: GitLabCallSource;
  durationMs: number;
  statusCode: number | null;
  error: string | null;
  servedStale: boolean;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  requestId: string | null;
  createdAt: string;
};

export type GitLabWebhookDeliveryView = {
  id: string;
  webhookId: string;
  eventType: string;
  projectId: string | null;
  objectKind: string | null;
  action: string | null;
  outcome: string;
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
};

export type GitLabWebhookSetupView = {
  project: GitLabProjectView;
  callbackUrl: string;
  signingToken: string | null;
  manualConfigurationRequired: boolean;
};

export type GitLabAutoRetryExecutionView = {
  id: string;
  pipelineId: string;
  attempt: number;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitLabAutoRetryRuleView = {
  id: string;
  projectId: string;
  pipelineId: string | null;
  enabled: boolean;
  maxAttempts: number;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  executions: GitLabAutoRetryExecutionView[];
};

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  nextPage: number | null;
};
