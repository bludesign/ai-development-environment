"use client";

import { GitMerge, X } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { WorkflowQuickActions } from "@/components/workflows/workflow-quick-actions";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import { waitForWorktreeJob } from "./worktree-jobs";
import type { Worktree, WorktreeCodebaseGroup } from "./types";

export function WorktreeRebaseConflictItem({
  worktree,
  group,
  onCompleted,
  onError,
}: {
  worktree: Worktree;
  group: WorktreeCodebaseGroup;
  onCompleted: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("worktrees");
  const [cancelling, setCancelling] = useState(false);
  const quickActions = group.mergeConflictQuickActions ?? [];

  const cancel = async () => {
    setCancelling(true);
    try {
      const data = await controlPlaneRequest<{
        runWorktreeOperation: { id: string };
      }>(
        `mutation CancelWorktreeRebase($input: RunWorktreeOperationInput!) {
          runWorktreeOperation(input: $input) { id }
        }`,
        {
          input: {
            worktreeId: worktree.id,
            operation: "CANCEL_REBASE",
            requestId: createClientId(),
          },
        },
      );
      await waitForWorktreeJob(data.runWorktreeOperation.id);
      await onCompleted();
      onError(null);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Item
      className={cn(
        "empty:hidden",
        worktree.rebaseInProgress
          ? "border-destructive/40 bg-[color-mix(in_oklab,var(--destructive)_8%,var(--card))]"
          : "border-0 p-0",
      )}
      size="sm"
      variant="outline"
    >
      {worktree.rebaseInProgress && (
        <>
          <ItemMedia variant="icon">
            <GitMerge className="text-destructive" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("rebasePaused")}</ItemTitle>
            <ItemDescription>
              {t(
                worktree.hasConflicts ? "rebaseConflicts" : "rebaseIncomplete",
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              disabled={cancelling}
              onClick={() => void cancel()}
              size="sm"
              variant="outline"
            >
              {cancelling ? <Spinner /> : <X />}
              {t("cancelRebase")}
            </Button>
          </ItemActions>
        </>
      )}
      <WorkflowQuickActions
        activeOnly={!worktree.rebaseInProgress || !worktree.hasConflicts}
        className={
          worktree.rebaseInProgress
            ? "-mx-3 -mb-2.5 basis-[calc(100%+(var(--spacing)*6))] rounded-b-lg border-t border-destructive/30 bg-[color-mix(in_oklab,var(--destructive)_16%,var(--card))] px-3 py-2.5"
            : undefined
        }
        sessionData={{
          worktree: {
            id: worktree.id,
            path: worktree.folder,
            branch: worktree.branch,
            baseBranch: worktree.baseBranch,
            headSha: worktree.headSha,
            rebaseInProgress: worktree.rebaseInProgress,
            hasConflicts: worktree.hasConflicts,
          },
          codebase: {
            id: group.codebase.id,
            folder: group.codebase.folder,
          },
          repo: {
            id: group.repository.id,
            name: group.repository.name,
            url: group.repository.displayOrigin,
            displayOrigin: group.repository.displayOrigin,
          },
        }}
        worktreeId={worktree.id}
        workflows={quickActions}
      />
    </Item>
  );
}
