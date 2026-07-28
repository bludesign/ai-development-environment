import type { WorktreeDiffFile } from "@/components/worktrees/types";

/** The five diff scopes the git backend understands. */
export type DiffScope =
  "BRANCH" | "COMMIT" | "STAGED" | "UNSTAGED" | "UNTRACKED";

/** Columns the sidebar file list can be ordered by. */
export type DiffFileSort =
  "additions" | "changeType" | "coverage" | "deletions" | "module" | "name";

/** A worktree as far as this page is concerned — enough to pick and scope one. */
export type DiffWorktreeOption = {
  id: string;
  branch: string;
  relativePath: string;
  folder: string;
  headSha: string | null;
  baseBranch: string | null;
  availability: string;
  codebaseName: string;
  pullRequest: {
    number: number;
    title: string;
    url: string;
    state: string;
    headRefOid: string;
    repositoryNameWithOwner: string;
  } | null;
};

/** One row of the sidebar file list, before coverage is joined in. */
export type DiffFileEntry = WorktreeDiffFile & {
  /** Stable key; a path alone can repeat across a rename pair. */
  key: string;
  /** Coverage percentage for the file, when a report covers it. */
  lineCoverage: number | null;
  /** Owning target or module, when a report knows one. */
  module: string | null;
};

/** A commit in the branch's history, for the COMMIT scope picker. */
export type DiffCommit = {
  sha: string;
  subject: string;
  authorName: string;
  authoredAt: string;
  additions: number;
  deletions: number;
};
