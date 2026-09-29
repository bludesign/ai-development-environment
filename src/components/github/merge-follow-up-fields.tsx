"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export type MergeFollowUpOptions = {
  canDeleteWorktree: boolean;
  worktreeFolder: string | null;
  ticketKey: string | null;
  ticketDoneStatusConfigured: boolean;
};

export const MERGE_FOLLOW_UP_FIELDS = `defaultMethod defaultMoveTicketToDone defaultDeleteWorktree
  worktreeId worktreeFolder canDeleteWorktree ticketKey ticketDoneStatusConfigured`;

export function MergeFollowUpFields({
  options,
  disabled,
  deleteWorktree,
  moveTicketToDone,
  onDeleteWorktreeChange,
  onMoveTicketToDoneChange,
}: {
  options: MergeFollowUpOptions;
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
