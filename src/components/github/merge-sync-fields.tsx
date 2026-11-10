"use client";

import { useCallback, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MergeConflictWorkflowFields } from "@/services/worktrees/merge-branch-sync";

export const MERGE_CONFLICT_WORKFLOW_FIELDS = `
  defaultConflictWorkflowId defaultConflictWorkflowChoice conflictWorkflowBlockedReason
  autoSyncRequiresConflictWorkflow
  mergeConflictWorkflows {
    id name
    hasPlainTrigger(resourceKind: "WORKTREE")
    triggerChoices(resourceKind: "WORKTREE") { key label }
  }
`;

type Selection = { enabled: boolean; id: string; choice: string };

export function useMergeConflictWorkflow(
  autoSync: boolean,
  options?: MergeConflictWorkflowFields | null,
) {
  const [selection, setSelection] = useState<Selection>({
    enabled: false,
    id: "",
    choice: "",
  });
  const selected = options?.mergeConflictWorkflows?.find(
    (workflow) => workflow.id === selection.id,
  );
  const load = useCallback((next: MergeConflictWorkflowFields) => {
    setSelection({
      enabled: Boolean(next.defaultConflictWorkflowId),
      id: next.defaultConflictWorkflowId ?? "",
      choice: next.defaultConflictWorkflowChoice ?? "",
    });
  }, []);
  const valid =
    !autoSync ||
    (selection.enabled
      ? Boolean(
          selection.choice
            ? selected?.triggerChoices?.some(
                ({ key }) => key === selection.choice,
              )
            : selected?.hasPlainTrigger,
        )
      : !options?.autoSyncRequiresConflictWorkflow);
  return {
    valid,
    input:
      autoSync && selection.enabled && valid
        ? {
            conflictWorkflowId: selection.id,
            ...(selection.choice
              ? { conflictWorkflowChoice: selection.choice }
              : {}),
          }
        : {},
    load,
    fields: { selection, onChange: setSelection, options },
  };
}

function ConflictWorkflowFields({
  selection,
  onChange,
  options,
  disabled,
}: {
  selection: Selection;
  onChange: (selection: Selection) => void;
  options?: MergeConflictWorkflowFields | null;
  disabled?: boolean;
}) {
  const t = useTranslations("pullRequests");
  const id = useId();
  const workflows = options?.mergeConflictWorkflows ?? [];
  const selected = workflows.find((workflow) => workflow.id === selection.id);
  const choices = selected?.triggerChoices ?? [];
  return (
    <div className="space-y-2 border-t pt-2">
      <div className="flex items-center gap-3">
        <Checkbox
          id={id}
          checked={selection.enabled}
          disabled={disabled || (!selection.enabled && workflows.length === 0)}
          onCheckedChange={(value) =>
            onChange({ ...selection, enabled: value === true })
          }
        />
        <Label htmlFor={id}>{t("autoResolveMergeConflicts")}</Label>
      </div>
      {options?.conflictWorkflowBlockedReason && (
        <p className="text-xs text-muted-foreground">
          {options.conflictWorkflowBlockedReason}
        </p>
      )}
      {options?.autoSyncRequiresConflictWorkflow && !selection.enabled && (
        <p className="text-xs text-muted-foreground">
          {t("conflictWorkflowRequired")}
        </p>
      )}
      {selection.enabled && (
        <>
          <Select
            disabled={disabled}
            value={selected?.id ?? ""}
            onValueChange={(id) => onChange({ enabled: true, id, choice: "" })}
          >
            <SelectTrigger aria-label={t("mergeConflictWorkflow")}>
              <SelectValue placeholder={t("selectMergeConflictWorkflow")} />
            </SelectTrigger>
            <SelectContent>
              {workflows.map((workflow) => (
                <SelectItem key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {choices.length > 0 && (
            <Select
              disabled={disabled}
              value={
                selection.choice
                  ? `choice:${selection.choice}`
                  : selected?.hasPlainTrigger
                    ? "plain"
                    : ""
              }
              onValueChange={(value) =>
                onChange({
                  ...selection,
                  choice:
                    value === "plain" ? "" : value.slice("choice:".length),
                })
              }
            >
              <SelectTrigger aria-label={t("mergeConflictWorkflowTrigger")}>
                <SelectValue
                  placeholder={t("selectMergeConflictWorkflowTrigger")}
                />
              </SelectTrigger>
              <SelectContent>
                {selected?.hasPlainTrigger && (
                  <SelectItem value="plain">
                    {t("defaultMergeConflictWorkflowTrigger")}
                  </SelectItem>
                )}
                {choices.map((choice) => (
                  <SelectItem key={choice.key} value={`choice:${choice.key}`}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </>
      )}
    </div>
  );
}

export function MergeSyncFields({
  checked,
  onChange,
  disabled,
  unavailableReason,
  conflictWorkflow,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  unavailableReason?: string | null;
  conflictWorkflow?: Omit<
    Parameters<typeof ConflictWorkflowFields>[0],
    "disabled"
  >;
}) {
  const t = useTranslations("pullRequests");
  const id = useId();
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled || Boolean(unavailableReason)}
          onCheckedChange={(value) => onChange(value === true)}
        />
        <Label htmlFor={id}>{t("autoSyncBranch")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {unavailableReason ?? t("autoSyncBranchDescription")}
      </p>
      {checked && conflictWorkflow && (
        <ConflictWorkflowFields
          {...conflictWorkflow}
          disabled={disabled || Boolean(unavailableReason)}
        />
      )}
    </div>
  );
}

export function MergeSyncStatus({ state }: { state?: string }) {
  const t = useTranslations("pullRequests");
  if (
    !state ||
    ![
      "SYNCING",
      "RESOLVING",
      "WAITING_CI",
      "WAITING_REQUIREMENTS",
      "MERGING",
      "ACTION_REQUIRED",
    ].includes(state)
  )
    return null;
  return (
    <p role="status" className="text-sm">
      {t(`syncStates.${state}`)}
    </p>
  );
}
