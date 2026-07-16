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

export type GitHubSettingsView = {
  tokenConfigured: boolean;
  updatedAt: string;
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
