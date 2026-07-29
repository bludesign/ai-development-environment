/**
 * A deliberately slim worktree selection. The worktrees page pulls a very large
 * overview; this page only needs enough to populate its selector and to decide
 * whether commenting is safe.
 */
export const DIFF_WORKTREES_QUERY = `query DiffWorktrees {
  worktreeOverview {
    agents {
      codebases {
        repository { id name displayOrigin }
        codebase { id folder defaultBranch }
        worktrees {
          id branch relativePath folder headSha baseBranch availability
          pullRequest {
            number title url state headRefOid repositoryNameWithOwner
          }
        }
      }
    }
  }
}`;

export { INSPECT_WORKTREE_DIFF_MUTATION } from "@/components/worktrees/worktree-graphql";

/**
 * Only the parts of `inspectWorktree` this page uses. The working-tree change
 * list is the sole source of files for the staged, unstaged, and untracked
 * scopes — those scopes reject a null path in `inspectWorktreeDiff`.
 */
export const DIFF_WORKTREE_DETAIL_MUTATION = `mutation DiffWorktreeDetail($id: ID!, $requestId: ID!) {
  inspectWorktree(id: $id, requestId: $requestId) {
    commits { sha subject authorName authoredAt additions deletions }
    changes {
      path previousPath changeType staged unstaged untracked conflicted
      stagedAdditions stagedDeletions unstagedAdditions unstagedDeletions
    }
    branchChanges { path previousPath changeType additions deletions binary image }
    commitsTruncated changesTruncated branchChangesTruncated
  }
}`;

/**
 * The coverage picker's options. Deliberately excludes the per-file payloads:
 * a worktree keeps up to fifty reports, and only the selected one is ever read.
 */
export const DIFF_COVERAGE_REPORTS_QUERY = `query DiffCoverageReports($worktreeId: ID!) {
  worktreeCoverageReports(worktreeId: $worktreeId) {
    id status createdAt finishedAt
    coverageSummary { lineCoverage changedLineCoverage }
    build { id snapshot }
  }
}`;

/**
 * The selected report's file data. There is no report-by-id query, so this goes
 * through the owning build and picks the report out of its list.
 */
export const DIFF_COVERAGE_REPORT_QUERY = `query DiffCoverageReport($buildId: ID!) {
  build(id: $buildId) {
    id
    reports {
      id kind status
      coverageFiles { target path lineCoverage }
      changedCoverageFiles { path coveredLineNumbers uncoveredLineNumbers }
    }
  }
}`;
