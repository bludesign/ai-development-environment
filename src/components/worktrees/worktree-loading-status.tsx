"use client";

import { Check, CircleAlert, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ENRICHMENT_KINDS,
  type EnrichmentKind,
  type LoadTimings,
  type LoadingStage,
} from "./use-worktree-loading";

export function WorktreeLoadingStatus({
  timings,
  onRetry,
  onRetrySaved,
}: {
  timings: LoadTimings;
  onRetry: (kind: EnrichmentKind) => void;
  onRetrySaved: () => void;
}) {
  const t = useTranslations("worktrees.loadingStatus");
  const [now, setNow] = useState(() => Date.now());
  const stages: LoadingStage[] = ["SAVED", ...ENRICHMENT_KINDS];
  const active = stages.filter((stage) => timings[stage].status === "running");
  const waiting =
    timings.SAVED.status !== "failed" &&
    stages.some((stage) => timings[stage].status === "pending");
  const running = active.length > 0 || waiting;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);
  const hasWarnings = stages.some((stage) =>
    ["warning", "failed"].includes(timings[stage].status),
  );
  const total = (stage: LoadingStage) => {
    const timing = timings[stage];
    return timing.startedAt === null
      ? "—"
      : `${(Math.max(0, (timing.finishedAt ?? now) - timing.startedAt) / 1000).toFixed(1)}s`;
  };
  const label = active.length
    ? t(timings.SAVED.status === "running" ? "loading" : "updating", {
        stages: active.map((stage) => t(stage)).join(", "),
      })
    : t(hasWarnings ? "warning" : waiting ? "starting" : "updated");

  return (
    <div
      data-testid="worktree-loading-status"
      className="flex h-10 shrink-0 items-center justify-between gap-3 rounded-md border px-3 text-sm text-muted-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        {running ? (
          <Spinner aria-hidden="true" />
        ) : hasWarnings ? (
          <CircleAlert className="size-4 shrink-0 text-amber-600" />
        ) : (
          <Check className="size-4 shrink-0" />
        )}
        <span
          className="truncate"
          role="status"
          aria-live="polite"
          title={label}
        >
          {label}
        </span>
        {active.length > 0 && (
          <span
            className="shrink-0 font-mono text-xs tabular-nums"
            aria-hidden="true"
          >
            {total(active[0])}
          </span>
        )}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 shrink-0">
            {t("details")} <ChevronDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="max-h-[70vh] w-[min(30rem,calc(100vw-2rem))] overflow-auto p-4"
          aria-label={t("details")}
        >
          <h2 className="font-medium">{t("details")}</h2>
          <p className="text-xs text-muted-foreground">{t("explanation")}</p>
          <ul className="divide-y">
            {stages.map((stage) => {
              const timing = timings[stage];
              return (
                <li key={stage} className="space-y-1.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{t(stage)}</span>
                    <span>{t(timing.status)}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                    <span>{t("elapsed", { time: total(stage) })}</span>
                    {timing.durationMs !== null && (
                      <span>
                        {t("server", {
                          time: `${(timing.durationMs / 1000).toFixed(2)}s`,
                        })}
                      </span>
                    )}
                  </div>
                  {timing.warnings.map((warning, index) => (
                    <p
                      key={index}
                      className="break-words text-xs text-amber-700 dark:text-amber-300"
                    >
                      {warning}
                    </p>
                  ))}
                  {["failed", "warning"].includes(timing.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        stage === "SAVED" ? onRetrySaved() : onRetry(stage)
                      }
                    >
                      {t("retry")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
