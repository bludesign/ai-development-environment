"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";

import type { WorktreeInProgressRunCount } from "./types";

export function WorktreeRunBadges({
  counts,
}: {
  counts?: WorktreeInProgressRunCount;
}) {
  const t = useTranslations("worktrees");
  if (!counts || (!counts.sessionCount && !counts.planCount)) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {counts.sessionCount > 0 && (
        <Badge variant="secondary">
          {t("sessionsInProgress", { count: counts.sessionCount })}
        </Badge>
      )}
      {counts.planCount > 0 && (
        <Badge variant="secondary">
          {t("plansInProgress", { count: counts.planCount })}
        </Badge>
      )}
    </div>
  );
}
