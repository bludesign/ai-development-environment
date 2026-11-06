"use client";

import { useEffect, type ReactNode } from "react";
import { GitMerge } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useTranslations } from "next-intl";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  getMergeOperationSnapshot,
  postMergeSwitchPending,
  recordPostMergeSwitch,
  recordMergeOperationProgress,
  clearMergeOperationProgress,
  useMergeOperation,
  type PostMergeSwitchStatus,
} from "./merge-operation-state";

export const POST_MERGE_SWITCH_FIELDS = `postMergeSwitch { branch state lastError }`;
type Operation = {
  state: string;
  lastError?: string | null;
  mergeConfirmedAt?: string | null;
  postMergeSwitch?: PostMergeSwitchStatus | null;
};
type Target =
  | { provider: "github"; owner: string; name: string; number: number }
  | { provider: "gitlab"; projectId: string; iid: number };

const watchers = new Map<string, Promise<void>>();
const ACTIVE_OPERATION_STATES = new Set([
  "SYNCING",
  "WAITING_CI",
  "WAITING_REQUIREMENTS",
  "MERGING",
  "POST_MERGE",
]);

async function loadOperation(target: Target): Promise<Operation | null> {
  if (target.provider === "github") {
    const data = await controlPlaneRequest<{
      githubPullRequestMergeOperation: Operation | null;
    }>(
      `query GitHubPullRequestMergeOperation($owner: String!, $name: String!, $number: Int!) {
        githubPullRequestMergeOperation(owner: $owner, name: $name, number: $number) {
          state lastError ${POST_MERGE_SWITCH_FIELDS}
        }
      }`,
      { owner: target.owner, name: target.name, number: target.number },
    );
    return data.githubPullRequestMergeOperation ?? null;
  }
  const data = await controlPlaneRequest<{
    gitlabMergeOperation: Operation | null;
  }>(
    `query GitLabMergeOperation($projectId: ID!, $iid: Int!) {
      gitlabMergeOperation(projectId: $projectId, iid: $iid) {
        state lastError mergeConfirmedAt ${POST_MERGE_SWITCH_FIELDS}
      }
    }`,
    { projectId: target.projectId, iid: target.iid },
  );
  return data.gitlabMergeOperation ?? null;
}

/** Session-owned polling keeps a dismissed or unmounted sheet's progress current. */
export function trackPostMergeSwitch(
  key: string,
  target: Target,
  initial?: PostMergeSwitchStatus | null,
  label?: string,
): Promise<void> {
  label ??=
    target.provider === "github"
      ? `${target.owner}/${target.name} #${target.number}`
      : `GitLab !${target.iid}`;
  if (initial) {
    recordMergeOperationProgress(
      key,
      false,
      initial.lastError,
      label,
      initial.state === "ACTION_REQUIRED" ? "ACTION_REQUIRED" : "POST_MERGE",
    );
    recordPostMergeSwitch(key, initial, label);
  }
  const current = watchers.get(key);
  if (current) return current;
  const watch = (async () => {
    let failures = 0;
    for (;;) {
      try {
        const operation = await loadOperation(target);
        const status = operation?.postMergeSwitch;
        if (!status) {
          const snapshot = getMergeOperationSnapshot(key);
          // A cancellation can race the provider confirming the merge. Let its
          // mutation settle before discarding the coordinator's previous state.
          if (snapshot.mutationPending) {
            await new Promise<void>((resolve) =>
              window.setTimeout(resolve, 2000),
            );
            continue;
          }
          if (!postMergeSwitchPending(snapshot.postMergeSwitch)) {
            clearMergeOperationProgress(key);
            return;
          }
          if (++failures >= 3)
            throw new Error(
              "The merge follow-up could not be found. Refresh and retry.",
            );
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, 2000),
          );
          continue;
        }
        failures = 0;
        // An enabled auto-merge may wait for CI. Its checkout follow-up starts
        // only after the provider confirms the merge.
        const confirmed =
          operation?.mergeConfirmedAt ||
          operation?.state === "POST_MERGE" ||
          status.state !== "PENDING" ||
          Boolean(getMergeOperationSnapshot(key).postMergeSwitch);
        if (operation?.state === "ACTION_REQUIRED") {
          if (confirmed) {
            recordPostMergeSwitch(
              key,
              status.state === "COMPLETED"
                ? status
                : {
                    ...status,
                    state: "ACTION_REQUIRED",
                    lastError: operation.lastError ?? status.lastError,
                  },
              label,
            );
          }
          recordMergeOperationProgress(
            key,
            false,
            operation.lastError ?? status.lastError,
            label,
            operation.state,
          );
          return;
        }
        if (confirmed) {
          recordMergeOperationProgress(
            key,
            false,
            null,
            label,
            operation?.state,
          );
          recordPostMergeSwitch(key, status, label);
        } else {
          recordMergeOperationProgress(
            key,
            operation?.state === "MERGING",
            operation?.state === "ACTION_REQUIRED"
              ? (operation.lastError ?? null)
              : null,
            label,
            operation?.state,
          );
          if (
            ["ACTION_REQUIRED", "CANCELED", "CANCELLED", "COMPLETED"].includes(
              operation!.state,
            )
          )
            return;
        }
        if (
          status.state === "ACTION_REQUIRED" ||
          ["COMPLETED", "CANCELED", "CANCELLED"].includes(operation!.state)
        )
          return;
      } catch (error) {
        const snapshot = getMergeOperationSnapshot(key);
        const status = snapshot.postMergeSwitch;
        if (++failures >= 3) {
          if (
            !status &&
            !snapshot.pending &&
            !ACTIVE_OPERATION_STATES.has(
              snapshot.followUpOperation?.state ?? "",
            )
          )
            return;
          if (!status) {
            recordMergeOperationProgress(
              key,
              false,
              error instanceof Error ? error.message : String(error),
              label,
            );
            return;
          }
          recordPostMergeSwitch(
            key,
            {
              ...status,
              state: "ACTION_REQUIRED",
              lastError: error instanceof Error ? error.message : String(error),
            },
            label,
          );
          return;
        }
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 2000));
    }
  })().finally(() => {
    if (watchers.get(key) === watch) watchers.delete(key);
  });
  watchers.set(key, watch);
  return watch;
}

export function usePostMergeSwitchRecovery(
  key: string,
  target: Target,
  enabled: boolean,
) {
  const identity = JSON.stringify(target);
  useEffect(() => {
    if (enabled) void trackPostMergeSwitch(key, JSON.parse(identity) as Target);
  }, [key, identity, enabled]);
}

export function MergeOperationLabel({
  operationKey,
  idleLabel,
  pendingLabel,
}: {
  operationKey: string;
  idleLabel: string;
  pendingLabel: string;
}) {
  const t = useTranslations("pullRequests");
  const operation = useMergeOperation(operationKey);
  const status = operation.postMergeSwitch;
  if (status?.state === "COMPLETED")
    return t("switchedToDefaultBranch", { branch: status.branch });
  if (postMergeSwitchPending(status))
    return t("updatingDefaultBranch", { branch: status!.branch });
  return operation.pending ? pendingLabel : idleLabel;
}

export function PostMergeSwitchProgress({
  operationKey,
}: {
  operationKey: string;
}) {
  const t = useTranslations("pullRequests");
  const { postMergeSwitch: status } = useMergeOperation(operationKey);
  if (!status) return null;
  return (
    <div role="status" className="space-y-1 text-sm">
      <p>
        {t(
          status.state === "COMPLETED"
            ? "switchedToDefaultBranch"
            : status.state === "ACTION_REQUIRED"
              ? "switchToDefaultBranchFailed"
              : "updatingDefaultBranch",
          { branch: status.branch },
        )}
      </p>
      {status.lastError && (
        <p className="text-destructive">{status.lastError}</p>
      )}
    </div>
  );
}

export function MergeOperationIcon({
  operationKey,
  children,
}: {
  operationKey: string;
  children?: ReactNode;
}) {
  const { pending } = useMergeOperation(operationKey);
  return pending ? (
    <Spinner aria-hidden="true" />
  ) : children === undefined ? (
    <GitMerge />
  ) : (
    children
  );
}
