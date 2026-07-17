import type { Agent, AgentJob } from "@/components/agents/types";

export type Codebase = {
  id: string;
  folder: string;
  observedOrigin: string;
  branch: string | null;
  headSha: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  syncState:
    | "IN_SYNC"
    | "AHEAD"
    | "BEHIND"
    | "DIVERGED"
    | "NO_UPSTREAM"
    | "DETACHED"
    | "UNKNOWN";
  availability:
    "AVAILABLE" | "MISSING" | "NOT_REPOSITORY" | "ORIGIN_MISMATCH" | "ERROR";
  statusError: string | null;
  defaultBranch: string | null;
  localBranches: string[];
  remoteBranches: string[];
  lastCheckedAt: string | null;
  lastFetchedAt: string | null;
  lastFetchAttemptAt: string | null;
  lastFetchError: string | null;
  agent: Agent;
  activeJob: AgentJob | null;
};

export type CodebaseRepository = {
  id: string;
  canonicalOrigin: string;
  displayOrigin: string;
  name: string;
  description: string;
  jiraBranchRegex: string | null;
  keepBaseBranchUpToDate: boolean;
  codebases: Codebase[];
  createdAt: string;
  updatedAt: string;
};

export type CodebaseSettings = {
  refreshIntervalSeconds: number;
  fetchIntervalSeconds: number;
  defaultJiraBranchRegex: string;
  updatedAt: string;
};

export type DirectoryListing = {
  path: string;
  parentPath: string | null;
  homePath: string;
  entries: Array<{ name: string; path: string; hidden: boolean }>;
  truncated: boolean;
};

export type Inspection = {
  jobId: string;
  snapshot: {
    folder: string;
    observedOrigin: string;
    canonicalOrigin: string;
    displayOrigin: string;
    branch: string | null;
    syncState: Codebase["syncState"];
  };
  existingRepository: CodebaseRepository | null;
};
