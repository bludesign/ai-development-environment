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
