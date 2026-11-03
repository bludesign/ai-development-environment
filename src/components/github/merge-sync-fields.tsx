"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export function MergeSyncFields({
  checked,
  onChange,
  disabled,
  unavailableReason,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  unavailableReason?: string | null;
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
    </div>
  );
}

export function MergeSyncStatus({ state }: { state?: string }) {
  const t = useTranslations("pullRequests");
  if (
    !state ||
    ![
      "SYNCING",
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
