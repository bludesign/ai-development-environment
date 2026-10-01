import {
  CODEBASE_BRANCHES_DELETE_JOB_KIND,
  type LocalBranch,
} from "@ai-development-environment/agent-contract/codebases";

import type { Codebase, CodebaseRepository } from "./types";

export type BranchRestriction =
  | "current"
  | "default"
  | "defaultUnknown"
  | "worktree"
  | "offline"
  | "unsupported"
  | "unavailable"
  | "busy"
  | "scanFailed"
  | "metadataMissing";
export interface BranchRow {
  key: string;
  branch: LocalBranch;
  codebase: Codebase;
  repository: CodebaseRepository;
  scannedAt: string | null;
  restriction: BranchRestriction | null;
}

export const branchKey = (codebaseId: string, name: string) =>
  `${codebaseId}:${name}`;

export function localBranchRows(
  repositories: CodebaseRepository[],
): BranchRow[] {
  return repositories.flatMap((repository) =>
    repository.codebases.flatMap((codebase) => {
      const inventory = codebase.localBranchInventory;
      const branches =
        inventory?.branches ??
        (codebase.localBranches ?? []).map((name) => ({
          name,
          headSha: "",
          lastCommitAt: null,
          lastCommitMessage: null,
          current: name === codebase.branch,
          checkedOutPath: null,
        }));
      return branches.map((branch): BranchRow => ({
        key: branchKey(codebase.id, branch.name),
        branch,
        codebase,
        repository,
        scannedAt: inventory?.scannedAt ?? null,
        restriction: branch.current
          ? "current"
          : branch.name === codebase.defaultBranch
            ? "default"
            : branch.checkedOutPath
              ? "worktree"
              : codebase.agent.connectionStatus !== "ONLINE"
                ? "offline"
                : !codebase.agent.capabilities.includes(
                      CODEBASE_BRANCHES_DELETE_JOB_KIND,
                    )
                  ? "unsupported"
                  : codebase.availability !== "AVAILABLE"
                    ? "unavailable"
                    : codebase.activeJob
                      ? "busy"
                      : codebase.localBranchInventoryError
                        ? "scanFailed"
                        : !branch.headSha
                          ? "metadataMissing"
                          : !codebase.defaultBranch
                            ? "defaultUnknown"
                            : null,
      }));
    }),
  );
}

export function filterBranchRows(
  rows: BranchRow[],
  agentId: string,
  repositoryId: string,
  olderThanDays: number | null,
  now = Date.now(),
): BranchRow[] {
  return rows
    .filter(
      (row) =>
        (agentId === "all" || row.codebase.agent.id === agentId) &&
        (repositoryId === "all" || row.repository.id === repositoryId) &&
        (olderThanDays === null ||
          (row.branch.lastCommitAt !== null &&
            Date.parse(row.branch.lastCommitAt) <=
              now - olderThanDays * 86_400_000)),
    )
    .sort(
      (a, b) =>
        (a.branch.lastCommitAt ? Date.parse(a.branch.lastCommitAt) : Infinity) -
          (b.branch.lastCommitAt
            ? Date.parse(b.branch.lastCommitAt)
            : Infinity) ||
        a.repository.name.localeCompare(b.repository.name) ||
        a.codebase.agent.name.localeCompare(b.codebase.agent.name) ||
        a.branch.name.localeCompare(b.branch.name),
    );
}

export function reconcileBranchSelection(
  selection: Record<string, string>,
  rows: BranchRow[],
): Record<string, string> {
  const eligible = new Map(
    rows
      .filter((row) => !row.restriction)
      .map((row) => [row.key, row.branch.headSha]),
  );
  return Object.fromEntries(
    Object.entries(selection).filter(([key, sha]) => eligible.get(key) === sha),
  );
}
