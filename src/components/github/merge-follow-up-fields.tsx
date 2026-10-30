"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

import type { MergeBaseBranchUpdateOptions } from "@/services/worktrees/merge-base-branch-updates";

export const BASE_BRANCH_UPDATE_FIELDS = `baseBranchUpdateOptions { destinationBaseBranch selectedWorktreeIds
  worktrees { id branch folder agentName baseBranch canUpdate } results { worktreeId folder status reason } }`;

export type MergeFollowUpOptions = {
  baseBranchUpdateOptions?: MergeBaseBranchUpdateOptions | null;
  canDeleteWorktree: boolean;
  worktreeFolder: string | null;
  ticketKey: string | null;
  ticketDoneStatusConfigured: boolean;
};

export const MERGE_FOLLOW_UP_FIELDS = `defaultMethod defaultMoveTicketToDone defaultDeleteWorktree
  worktreeId worktreeFolder canDeleteWorktree ticketKey ticketDoneStatusConfigured ${BASE_BRANCH_UPDATE_FIELDS}`;

export function MergeFollowUpFields({
  options,
  selectedWorktreeIds = [],
  onSelectedWorktreeIdsChange,
  disabled,
  deleteWorktree,
  moveTicketToDone,
  onDeleteWorktreeChange,
  onMoveTicketToDoneChange,
}: {
  options: MergeFollowUpOptions;
  selectedWorktreeIds?: string[];
  onSelectedWorktreeIdsChange?: (ids: string[]) => void;
  disabled: boolean;
  deleteWorktree: boolean;
  moveTicketToDone: boolean;
  onDeleteWorktreeChange: (value: boolean) => void;
  onMoveTicketToDoneChange: (value: boolean) => void;
}) {
  const t = useTranslations("pullRequests");
  const id = useId();
  return (
    <>
      {Boolean(options.baseBranchUpdateOptions?.worktrees.length) && (
        <fieldset className="min-w-0 space-y-3 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">
            {t("targetingWorktrees")}
          </legend>
          <p className="text-xs text-muted-foreground">
            {t("targetingWorktreesDescription")}
          </p>
          {!options.baseBranchUpdateOptions?.destinationBaseBranch && (
            <p role="alert" className="text-sm text-muted-foreground">
              {t("baseUpdateUnavailable")}
            </p>
          )}
          {options.baseBranchUpdateOptions?.worktrees.map((target) => (
            <div key={target.id} className="space-y-1">
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`${id}-base-${target.id}`}
                  checked={selectedWorktreeIds.includes(target.id)}
                  disabled={disabled || !target.canUpdate}
                  onCheckedChange={(checked) =>
                    onSelectedWorktreeIdsChange?.(
                      checked === true
                        ? [...selectedWorktreeIds, target.id]
                        : selectedWorktreeIds.filter(
                            (value) => value !== target.id,
                          ),
                    )
                  }
                />
                <Label
                  htmlFor={`${id}-base-${target.id}`}
                  className="min-w-0 break-words leading-snug"
                >
                  {target.branch ?? target.folder} · {target.agentName}
                </Label>
              </div>
              <p className="break-all text-xs text-muted-foreground">
                {target.folder}
              </p>
              <p className="break-all font-mono text-xs">
                {target.baseBranch} →{" "}
                {options.baseBranchUpdateOptions?.destinationBaseBranch ?? "—"}
              </p>
              {!target.canUpdate &&
                options.baseBranchUpdateOptions?.destinationBaseBranch && (
                  <p className="text-xs text-muted-foreground">
                    {t("baseUpdateInvalid")}
                  </p>
                )}
            </div>
          ))}
        </fieldset>
      )}
      {options.baseBranchUpdateOptions?.results.map((result) => (
        <p
          key={result.worktreeId}
          className="break-all text-xs text-muted-foreground"
        >
          {result.folder}:{" "}
          {t(
            result.status === "SKIPPED"
              ? "baseUpdateSkipped"
              : "baseUpdateCompleted",
          )}
        </p>
      ))}
      {options.canDeleteWorktree && (
        <div className="space-y-1">
          <div className="flex items-start gap-2">
            <Checkbox
              id={`${id}-delete`}
              checked={deleteWorktree}
              disabled={disabled}
              onCheckedChange={(value) =>
                onDeleteWorktreeChange(value === true)
              }
            />
            <Label htmlFor={`${id}-delete`}>
              {t("deleteWorktreeAfterMerge")}
            </Label>
          </div>
          <p className="break-all text-xs text-muted-foreground">
            {options.worktreeFolder}
          </p>
        </div>
      )}
      {options.ticketKey && (
        <div className="space-y-1">
          <div className="flex items-start gap-2">
            <Checkbox
              id={`${id}-jira`}
              checked={moveTicketToDone}
              disabled={disabled}
              onCheckedChange={(value) =>
                onMoveTicketToDoneChange(value === true)
              }
            />
            <Label htmlFor={`${id}-jira`}>
              {t("moveTicketToDoneAfterMerge", { ticket: options.ticketKey })}
            </Label>
          </div>
          {moveTicketToDone && !options.ticketDoneStatusConfigured && (
            <p role="alert" className="text-sm text-destructive">
              {t("jiraDoneStatusRequired")}
            </p>
          )}
        </div>
      )}
    </>
  );
}
