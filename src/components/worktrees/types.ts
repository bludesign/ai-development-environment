import type { Agent, AgentJob } from "@/components/agents/types";
import type {
  BuildArtifact,
  BuildDestination,
  BuildRecord,
} from "@/components/builds/types";
import type {
  Codebase,
  CodebaseRepository,
} from "@/components/codebases/types";
import type { GitHubPullRequestView } from "@/services/github/types";
import type {
  GitLabMergeOperationView,
  GitLabPipelineView,
} from "@/services/gitlab/types";

export type WorktreeSourceControlRequest = {
  provider: "GITHUB" | "GITLAB";
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  createdAt: string;
  projectId?: string;
  state?: string;
  worktreeId?: string | null;
  detailedMergeStatus?: string;
  mergeWhenPipelineSucceeds?: boolean;
  mergeOperation?: Pick<
    GitLabMergeOperationView,
    "autoMerge" | "autoSync" | "state" | "worktreeId"
  > | null;
  approvalState?: string | null;
  reviewers?: Array<{ id: string }>;
  unresolvedDiscussionsCount?: number | null;
};

export type WorktreeTag = {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
};

export type WorktreeLatestBuild = Pick<
  BuildRecord,
  "id" | "status" | "action" | "destinationType" | "createdAt" | "outOfDate"
> & {
  destination: BuildDestination;
  artifacts: Array<
    Pick<BuildArtifact, "id" | "kind"> &
      Partial<Pick<BuildArtifact, "metadata" | "checksum">>
  >;
};

export type WorktreeAutoSync = {
  worktreeId: string;
  state: string;
  conflictWorkflowId: string | null;
  conflictWorkflowChoice: string | null;
  lastError: string | null;
  pauseReason?:
    | "PREPARATION_CONFLICT"
    | "REBASE_CONFLICT"
    | "BRANCH_CHANGED"
    | "ERROR"
    | null;
  lastSyncedAt: string | null;
  updatedAt: string;
};

export type WorktreeAutoMerge = {
  postMergeSwitch?:
    | import("@/components/github/merge-operation-state").PostMergeSwitchStatus
    | null;
  ticketTransitionError?: string | null;
  autoSync?: boolean;
  worktreeId: string;
  state: string;
  repositoryNameWithOwner: string;
  pullRequestNumber: number;
  branch: string;
  mergeMethod: "MERGE" | "REBASE" | "SQUASH";
  commitHeadline: string;
  commitBody: string;
  authorEmail: string | null;
  deleteWorktree: boolean;
  moveTicketToDone: boolean;
  ticketKey: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type Worktree = {
  id: string;
  canAssignReviewers?: boolean;
  codebaseId: string;
  gitDirectory: string;
  folder: string;
  relativePath: string;
  primary: boolean;
  branch: string | null;
  isDefaultBranch?: boolean;
  defaultBranchUpdateEnabled?: boolean;
  defaultBranchUpdatePaused?: boolean;
  headSha: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  syncState: Codebase["syncState"];
  baseBranch: string | null;
  baseBranchOverride: string | null;
  baseAhead: number | null;
  baseBehind: number | null;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  rebaseInProgress: boolean;
  hasConflicts: boolean;
  pushStatus:
    "READY" | "DIRTY" | "DETACHED" | "BEHIND" | "DIVERGED" | "UNKNOWN";
  highlightColor: string | null;
  availability: string;
  statusError: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketStatus: string | null;
  pullRequest: GitHubPullRequestView | null;
  sourceControlRequest: WorktreeSourceControlRequest | null;
  gitLabPipelines: GitLabPipelineView[];
  latestBuild?: WorktreeLatestBuild | null;
  tags: WorktreeTag[];
  activeJob: AgentJob | null;
  blockingJob?: AgentJob | null;
  activeJobs?: AgentJob[];
  autoSync?: WorktreeAutoSync | null;
  autoMerge?: WorktreeAutoMerge | null;
  lastCheckedAt: string | null;
  missingAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorktreeQuickAction = {
  id: string;
  name: string;
  description: string;
  quickActionIconKey: string;
  quickActionButtonVariant: "default" | "outline" | "secondary" | "destructive";
  hasPlainTrigger?: boolean;
  triggerChoices?: Array<{
    key: string;
    label: string;
    description: string;
  }>;
};

export type WorktreeCodebaseGroup = {
  codebase: Codebase & {
    defaultBranch: string | null;
    localBranches: string[];
    remoteBranches: string[];
    lastFetchAttemptAt: string | null;
    lastFetchError: string | null;
  };
  repository: CodebaseRepository;
  worktrees: Worktree[];
  blockingJob?: AgentJob | null;
  hasPreparations?: boolean;
  iosBuildConfigured?: boolean;
  androidProjectEnabled?: boolean;
  androidBuildConfigured?: boolean;
  quickActions?: WorktreeQuickAction[];
  mergeConflictQuickActions?: WorktreeQuickAction[];
};

export type WorktreeAgentGroup = {
  agent: Agent;
  codebases: WorktreeCodebaseGroup[];
};

export type WorktreeOverview = {
  durationMs?: number;
  agents: WorktreeAgentGroup[];
  tags: WorktreeTag[];
  settings: {
    editorVariant: "CODE" | "CODE_INSIDERS" | "NONE";
    updatedAt: string;
  };
  hiddenCount: number;
  activeMoves: WorktreeMove[];
  activeSyncBatches?: WorktreeSyncBatch[];
};

export type WorktreeSyncItemStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "SKIPPED"
  | "ATTENTION_REQUIRED";

export type WorktreeSyncBatchItem = {
  id: string;
  worktreeId: string;
  codebaseId: string;
  agentId: string;
  agentName: string;
  repositoryId: string;
  repositoryName: string;
  branch: string;
  baseBranch: string;
  folder: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  baseBehind: number;
  status: WorktreeSyncItemStatus;
  jobId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorktreeSyncBatch = {
  id: string;
  status: "ACTIVE" | "COMPLETED";
  appId: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  items: WorktreeSyncBatchItem[];
};

export type WorktreeMove = {
  id: string;
  sourceWorktreeId: string;
  sourceCodebaseId: string;
  targetCodebaseId: string;
  targetWorktreeId: string | null;
  destinationMode: "NEW" | "EXISTING";
  branch: string;
  headSha: string;
  deleteSource: boolean;
  status:
    | "PUSHING"
    | "CHECKING_OUT"
    | "AWAITING_STASH"
    | "CLEANING_UP"
    | "SUCCEEDED"
    | "SUCCEEDED_WITH_WARNING"
    | "FAILED"
    | "CANCELLED";
  sourceJobId: string | null;
  targetJobId: string | null;
  cleanupJobId: string | null;
  error: string | null;
  warning: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type WorktreeDetail = {
  commits: Array<{
    sha: string;
    subject: string;
    message?: string | null;
    authorName: string;
    authoredAt: string;
    additions: number;
    deletions: number;
  }>;
  changes: Array<{
    path: string;
    previousPath?: string | null;
    changeType?: string;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    conflicted: boolean;
    stagedAdditions: number | null;
    stagedDeletions: number | null;
    unstagedAdditions: number | null;
    unstagedDeletions: number | null;
  }>;
  branchChanges?: WorktreeDiffFile[];
  commitsTruncated: boolean;
  changesTruncated: boolean;
  branchChangesTruncated?: boolean;
  commitSigningEnabled?: boolean;
};

export type WorktreeDiffFile = {
  path: string;
  previousPath: string | null;
  changeType: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  image: boolean;
};

export type WorktreeFileDiff = {
  files: WorktreeDiffFile[];
  patch?: string | null;
  image?: boolean | null;
  binary?: boolean | null;
  truncated: boolean;
  beforeAvailable?: boolean | null;
  afterAvailable?: boolean | null;
};
