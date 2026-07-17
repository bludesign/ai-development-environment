import type { Agent, AgentJob } from "@/components/agents/types";
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
  highlightColor: string | null;
  availability: string;
  statusError: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketStatus: string | null;
  pullRequest: GitHubPullRequestView | null;
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
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    conflicted: boolean;
    stagedAdditions: number | null;
    stagedDeletions: number | null;
    unstagedAdditions: number | null;
    unstagedDeletions: number | null;
  }>;
  commitsTruncated: boolean;
  changesTruncated: boolean;
};
