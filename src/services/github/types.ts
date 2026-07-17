export type GitHubPullRequestScope = "MINE" | "REVIEW_REQUESTED" | "REPOSITORY";

export type GitHubPullRequestState = "OPEN" | "CLOSED" | "MERGED";

export type GitHubPipelineStatus =
  "ERROR" | "EXPECTED" | "FAILURE" | "PENDING" | "SUCCESS" | "NONE";

export type GitHubPipelineState =
  | "ACTION_REQUIRED"
  | "CANCELLED"
  | "ERROR"
  | "EXPECTED"
  | "FAILURE"
  | "IN_PROGRESS"
  | "NEUTRAL"
  | "PENDING"
  | "QUEUED"
  | "SKIPPED"
  | "STALE"
  | "STARTUP_FAILURE"
  | "SUCCESS"
  | "TIMED_OUT"
  | "NONE";

export type GitHubReviewDecision =
  "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "NONE";

export type GitHubMergeMethod = "MERGE" | "REBASE" | "SQUASH";

export type GitHubPipelineRetryUnavailableReason =
  | "GITHUB_APP_NOT_CONFIGURED"
  | "NOT_COMPLETED"
  | "NOT_GITHUB_ACTIONS"
  | "WORKFLOW_RUN_UNAVAILABLE";

export type GitHubSettingsView = {
  tokenConfigured: boolean;
  defaultJiraKeyRegex: string;
  updatedAt: string;
};

export type GitHubAppSettingsView = {
  configured: boolean;
  appId: string | null;
  installationId: string | null;
  privateKeyConfigured: boolean;
  keyFingerprint: string | null;
  appSlug: string | null;
  accountLogin: string | null;
  repositorySelection: string | null;
  actionsPermission: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
};

export type GitHubAuditContext = {
  actor: "control-plane";
  ipAddress: string | null;
};

export type GitHubViewer = {
  login: string;
  name: string | null;
  avatarUrl: string;
  url: string;
};

export type GitHubRepositoryView = {
  id: string;
  githubId: string;
  owner: string;
  name: string;
  nameWithOwner: string;
  url: string;
  jiraKeyRegex: string | null;
};

export type GitHubRepositoryCandidate = {
  githubId: string;
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
  managed: boolean;
};

export type GitHubRepositoryCandidatePage = {
  items: GitHubRepositoryCandidate[];
  hasNextPage: boolean;
  endCursor: string | null;
};

export type GitHubPipelineView = {
  id: string;
  name: string;
  status: GitHubPipelineState;
  url: string | null;
  checkSuiteId: string | null;
  canRetry: boolean;
  retryUnavailableReason: GitHubPipelineRetryUnavailableReason | null;
  jobs: GitHubWorkflowJobView[];
  workflowRunId?: string | null;
};

export type GitHubWorkflowJobStepView = {
  number: number;
  name: string;
  status: GitHubPipelineState;
};

export type GitHubWorkflowJobView = {
  id: string;
  name: string;
  status: GitHubPipelineState;
  url: string | null;
  canRetry: boolean;
  retryUnavailableReason: GitHubPipelineRetryUnavailableReason | null;
  steps: GitHubWorkflowJobStepView[];
};

export type GitHubActionsRepositoryView = {
  id: string;
  nameWithOwner: string;
  url: string;
};

export type GitHubActionsRepositoryErrorView = {
  codebaseRepositoryId: string;
  nameWithOwner: string;
  message: string;
};

export type GitHubActionsPullRequestView = {
  number: number;
  url: string;
};

export type GitHubActionsWorkflowRunView = {
  id: string;
  repositoryGithubId: string;
  codebaseRepositoryId: string;
  repositoryNameWithOwner: string;
  repositoryUrl: string;
  name: string;
  displayTitle: string;
  runNumber: number;
  runAttempt: number;
  event: string;
  status: GitHubPipelineState;
  url: string;
  headBranch: string | null;
  headSha: string;
  checkSuiteId: string | null;
  canRetry: boolean;
  retryUnavailableReason: GitHubPipelineRetryUnavailableReason | null;
  pullRequests: GitHubActionsPullRequestView[];
  jiraKey: string | null;
  worktreeId: string | null;
  startedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type GitHubActionsWorkflowRunPage = {
  items: GitHubActionsWorkflowRunView[];
  repositories: GitHubActionsRepositoryView[];
  repositoryErrors: GitHubActionsRepositoryErrorView[];
  hasNextPage: boolean;
  endCursor: string | null;
};

export type GitHubPullRequestView = {
  id: string;
  number: number;
  title: string;
  url: string;
  repositoryGithubId: string;
  repositoryNameWithOwner: string;
  repositoryUrl: string;
  labels: string[];
  jiraKey: string | null;
  pipelineStatus: GitHubPipelineStatus;
  pipelines: GitHubPipelineView[];
  reviewDecision: GitHubReviewDecision;
  unresolvedReviewThreadCount: number;
  state: GitHubPullRequestState;
  headRefName: string;
  createdAt: string;
};

export type GitHubPullRequestActor = {
  login: string;
  avatarUrl: string;
  url: string;
};

export type GitHubReviewComment = {
  id: string;
  body: string;
  bodyText: string;
  bodyHtml: string;
  url: string;
  author: GitHubPullRequestActor | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubReviewThreadPullRequest = {
  id: string;
  number: number;
  title: string;
  url: string;
  repositoryNameWithOwner: string;
};

export type GitHubReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  subjectType: "FILE" | "LINE";
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  resolvedBy: GitHubPullRequestActor | null;
  pullRequest: GitHubReviewThreadPullRequest;
  rootComment: GitHubReviewComment;
  replies: GitHubReviewComment[];
};

export type GitHubReviewThreadPage = {
  viewerLogin: string;
  pullRequests: GitHubReviewThreadPullRequest[];
  threads: GitHubReviewThread[];
  truncated: boolean;
};

export type GitHubReviewThreadState = {
  id: string;
  isResolved: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  resolvedBy: GitHubPullRequestActor | null;
};

export type GitHubPullRequestDetail = GitHubPullRequestView & {
  body: string;
  bodyHtml: string;
  author: GitHubPullRequestActor | null;
  assignees: GitHubPullRequestActor[];
  reviewThreads: GitHubReviewThread[];
  baseRefName: string;
  headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
  additions: number;
  deletions: number;
  changedFiles: number | null;
  commitCount: number;
  updatedAt: string;
  mergedAt: string | null;
  worktreeId: string | null;
};

export type GitHubPullRequestMergeOptions = {
  availableMethods: GitHubMergeMethod[];
  commitEmails: string[];
  defaultCommitEmail: string | null;
  defaultCommitHeadline: string;
  defaultCommitBody: string;
  canMerge: boolean;
  blockedReason: string | null;
};

export type GitHubPullRequestMergeResult = {
  id: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  url: string;
  mergedAt: string | null;
};

export type GitHubPullRequestPage = {
  items: GitHubPullRequestView[];
  truncated: boolean;
};
