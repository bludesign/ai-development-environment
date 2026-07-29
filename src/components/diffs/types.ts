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
  codeStateHash: string | null;
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

/** One option in the coverage picker — enough to label and locate a report. */
export type DiffCoverageReportOption = {
  id: string;
  buildId: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  /** Overall coverage across the whole project, for the option label. */
  lineCoverage: number | null;
  /** Coverage of the branch's changed lines, for the option label. */
  changedLineCoverage: number | null;
  /**
   * HEAD revision the report measured. Used for branch and commit diffs, and as
   * a fallback for older working-tree reports without a complete state hash.
   */
  headSha: string | null;
  /** Complete worktree state measured by the build, including local changes. */
  codeStateHash: string | null;
};

/** The selected report's data for one file, keyed by worktree-relative path. */
export type DiffCoverageFile = {
  /** Whole-file coverage, or null when the report does not cover the file. */
  lineCoverage: number | null;
  /** Owning build target. */
  module: string | null;
  /** Executable lines the test run executed, in the report's revision. */
  covered: Set<number>;
  /** Executable lines the test run never executed. */
  uncovered: Set<number>;
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
