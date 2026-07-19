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
  artifacts: Array<Pick<BuildArtifact, "id" | "kind">>;
};

export type Worktree = {
  id: string;
  codebaseId: string;
  gitDirectory: string;
  folder: string;
  relativePath: string;
  primary: boolean;
  branch: string | null;
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
  pushStatus:
    "READY" | "DIRTY" | "DETACHED" | "BEHIND" | "DIVERGED" | "UNKNOWN";
  highlightColor: string | null;
  availability: string;
  statusError: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketStatus: string | null;
  pullRequest: GitHubPullRequestView | null;
  latestBuild?: WorktreeLatestBuild | null;
  tags: WorktreeTag[];
  activeJob: AgentJob | null;
  lastCheckedAt: string | null;
  missingAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  iosBuildConfigured?: boolean;
};

export type WorktreeAgentGroup = {
  agent: Agent;
  codebases: WorktreeCodebaseGroup[];
};

export type WorktreeOverview = {
  agents: WorktreeAgentGroup[];
  tags: WorktreeTag[];
  settings: {
    editorVariant: "CODE" | "CODE_INSIDERS" | "NONE";
    updatedAt: string;
  };
  hiddenCount: number;
  activeMoves: WorktreeMove[];
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
