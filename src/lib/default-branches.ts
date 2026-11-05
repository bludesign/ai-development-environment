import {
  isDefaultBranch,
  parseDefaultBranchPatterns,
} from "@ai-development-environment/agent-contract/codebases";

export function isDefaultWorktreeBranch(worktree: {
  branch: string | null;
  codebase: {
    defaultBranch: string | null;
    repository: { defaultBranchPatternsJson?: string | null };
  };
}): boolean {
  return isDefaultBranch(
    worktree.branch,
    worktree.codebase.defaultBranch,
    parseDefaultBranchPatterns(
      worktree.codebase.repository.defaultBranchPatternsJson,
    ),
  );
}
