export type GitHubPullRequestScope = "MINE" | "REVIEW_REQUESTED" | "REPOSITORY";

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

export type GitHubPipelineRetryUnavailableReason =
  | "GITHUB_APP_NOT_CONFIGURED"
  | "NOT_COMPLETED"
  | "NOT_GITHUB_ACTIONS"
  | "WORKFLOW_RUN_UNAVAILABLE";

export type GitHubSettingsView = {
  tokenConfigured: boolean;
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
  createdAt: string;
};

export type GitHubPullRequestActor = {
  login: string;
  avatarUrl: string;
  url: string;
};

export type GitHubPullRequestDetail = GitHubPullRequestView & {
  body: string;
  author: GitHubPullRequestActor | null;
  assignees: GitHubPullRequestActor[];
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
};

export type GitHubPullRequestPage = {
  items: GitHubPullRequestView[];
  truncated: boolean;
};
