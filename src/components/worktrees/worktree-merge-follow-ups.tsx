"use client";

import { useEffect, useState } from "react";

import { MergeOperationWarnings } from "@/components/github/merge-operation-warnings";
import {
  githubMergeOperationKey,
  gitlabMergeOperationKey,
} from "@/components/github/merge-operation-state";
import { usePostMergeSwitchRecovery } from "@/components/github/post-merge-switch-client";
import {
  controlPlaneRequest,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import type { WorktreeCodebaseGroup } from "./types";
import { WorktreeErrorAlert } from "./worktree-error-alert";

type GitLabOperation = {
  projectId: string;
  iid: number;
  worktreeId: string | null;
};

function GitHubRecovery({
  repositoryNameWithOwner,
  number,
}: {
  repositoryNameWithOwner: string;
  number: number;
}) {
  const [owner = "", name = ""] = repositoryNameWithOwner.split("/", 2);
  usePostMergeSwitchRecovery(
    githubMergeOperationKey({ repositoryNameWithOwner, number }),
    { provider: "github", owner, name, number },
    true,
  );
  return null;
}

function GitLabRecovery({ projectId, iid }: GitLabOperation) {
  usePostMergeSwitchRecovery(
    gitlabMergeOperationKey({ projectId, iid }),
    { provider: "gitlab", projectId, iid },
    true,
  );
  return null;
}

/** Follow-ups belong to the checkout, even after its source branch disappears. */
export function WorktreeMergeFollowUps({
  groups,
}: {
  groups: readonly WorktreeCodebaseGroup[];
}) {
  const githubRequests = new Map<
    string,
    { repositoryNameWithOwner: string; number: number }
  >();
  const gitlabWorktrees = new Map<string, [string, string | null, string]>();
  for (const group of groups) {
    for (const worktree of group.worktrees) {
      const rule = worktree.autoMerge;
      if (rule?.postMergeSwitch && rule.worktreeId === worktree.id) {
        const request = {
          repositoryNameWithOwner: rule.repositoryNameWithOwner,
          number: rule.pullRequestNumber,
        };
        githubRequests.set(githubMergeOperationKey(request), request);
      }
      if (
        worktree.primary &&
        group.repository.canonicalOrigin &&
        !/^github\.com\//i.test(group.repository.canonicalOrigin)
      ) {
        gitlabWorktrees.set(worktree.id, [
          worktree.id,
          worktree.branch,
          worktree.sourceControlRequest?.mergeOperation?.state ?? "",
        ]);
      }
    }
  }
  const scope = JSON.stringify(
    [...gitlabWorktrees.values()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const [saved, setSaved] = useState<{
    scope: string;
    operations: GitLabOperation[];
    error: string | null;
  } | null>(null);

  useEffect(() => {
    const worktreeIds = (JSON.parse(scope) as Array<[string]>).map(
      ([id]) => id,
    );
    if (!worktreeIds.length) return;
    let active = true;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const data = await controlPlaneRequest<{
          gitlabWorktreeMergeOperations: GitLabOperation[];
        }>(
          `query GitLabWorktreeMergeOperations($worktreeIds: [ID!]!) {
            gitlabWorktreeMergeOperations(worktreeIds: $worktreeIds) {
              projectId iid worktreeId
            }
          }`,
          { worktreeIds },
        );
        if (active && current === generation)
          setSaved({
            scope,
            operations: data.gitlabWorktreeMergeOperations ?? [],
            error: null,
          });
      } catch (error) {
        if (active && current === generation)
          setSaved((previous) => ({
            scope,
            operations:
              previous?.operations.filter(
                (operation) =>
                  operation.worktreeId &&
                  worktreeIds.includes(operation.worktreeId),
              ) ?? [],
            error: error instanceof Error ? error.message : String(error),
          }));
      }
    };
    void load();
    const unsubscribe = onControlPlaneRecovery(() => void load());
    return () => {
      active = false;
      unsubscribe();
    };
  }, [scope]);

  const gitlabOperations =
    saved?.operations.filter(
      (operation) =>
        operation.worktreeId && gitlabWorktrees.has(operation.worktreeId),
    ) ?? [];
  const operationKeys = [
    ...githubRequests.keys(),
    ...gitlabOperations.map(gitlabMergeOperationKey),
  ];
  return (
    <>
      {[...githubRequests].map(([key, request]) => (
        <GitHubRecovery key={key} {...request} />
      ))}
      {gitlabOperations.map((operation) => (
        <GitLabRecovery
          key={gitlabMergeOperationKey(operation)}
          {...operation}
        />
      ))}
      {saved?.scope === scope && saved.error && (
        <WorktreeErrorAlert error={saved.error} />
      )}
      <MergeOperationWarnings operationKeys={operationKeys} />
    </>
  );
}
