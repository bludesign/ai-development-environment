"use client";

import { ClipboardList, Terminal } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";

import type { WorktreeInProgressRunCount } from "./types";

export function WorktreeRunBadges({
  counts,
}: {
  counts?: WorktreeInProgressRunCount;
}) {
  const t = useTranslations("worktrees");
  const locale = useLocale();
  if (!counts || (!counts.sessionCount && !counts.planCount)) return null;
  const format = new Intl.NumberFormat(locale);
  const sessions = t("sessionsInProgress", { count: counts.sessionCount });
  const plans = t("plansInProgress", { count: counts.planCount });
  return (
    <div className="flex shrink-0 items-center gap-1 tabular-nums">
      {counts.sessionCount > 0 && (
        <Badge
          className="border-sky-500/30 bg-sky-500/15 text-sky-800 dark:text-sky-300"
          title={sessions}
          variant="outline"
        >
          <Terminal aria-hidden="true" />
          <span aria-hidden="true">{format.format(counts.sessionCount)}</span>
          <span className="sr-only">{sessions}</span>
        </Badge>
      )}
      {counts.planCount > 0 && (
        <Badge
          className="border-violet-500/30 bg-violet-500/15 text-violet-800 dark:text-violet-300"
          title={plans}
          variant="outline"
        >
          <ClipboardList aria-hidden="true" />
          <span aria-hidden="true">{format.format(counts.planCount)}</span>
          <span className="sr-only">{plans}</span>
        </Badge>
      )}
    </div>
  );
}
