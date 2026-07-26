"use client";

import { useState } from "react";
import {
  CheckCheck,
  ClipboardList,
  GitBranch,
  Hammer,
  MessagesSquare,
  Waypoints,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import { RunBuildControls } from "@/components/builds/run-build-controls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { formatEnumLabel } from "@/lib/enum-label";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightAccentClasses,
  worktreeHighlightBackgroundClasses,
} from "@/lib/worktree-highlight";

import { useActionCenter } from "./action-center-provider";
import { ActionCenterQuestionForm } from "./action-center-question-form";
import type {
  ActionCenterItem as ActionCenterItemView,
  ActionCenterResourceKind,
} from "./types";

const KIND_ICONS: Record<ActionCenterResourceKind, LucideIcon> = {
  PLAN: ClipboardList,
  SESSION: MessagesSquare,
  BUILD: Hammer,
  WORKFLOW: Waypoints,
};

function itemTitle(item: ActionCenterItemView, kind: string): string {
  if (item.resourceKind === "PLAN" || item.resourceKind === "SESSION") {
    return `${kind} #${item.displayNumber}`;
  }
  if (item.resourceKind === "WORKFLOW" && item.displayNumber !== null) {
    return `${item.label} #${item.displayNumber}`;
  }
  return item.label;
}

function reasonClass(
  reason: ActionCenterItemView["reason"],
): string | undefined {
  if (reason === "QUESTION")
    return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (reason === "UNRUN_BUILD")
    return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  return undefined;
}

export function ActionCenterItem({
  item,
  compact = false,
}: {
  item: ActionCenterItemView;
  compact?: boolean;
}) {
  const t = useTranslations("actionCenter");
  const { acknowledge, refresh, reportError } = useActionCenter();
  const [acknowledging, setAcknowledging] = useState(false);
  const Icon = KIND_ICONS[item.resourceKind];
  const kind = t(`kinds.${item.resourceKind}`);
  const title = itemTitle(item, kind);
  const color = item.worktree?.highlightColor;

  const acknowledgeFailure = async () => {
    setAcknowledging(true);
    try {
      await acknowledge(item);
    } catch {
      // The provider exposes the error in both Action Center surfaces.
    } finally {
      setAcknowledging(false);
    }
  };

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {item.buildRun && (
        <RunBuildControls
          buildId={item.buildRun.buildId}
          compact={compact}
          destinationType={item.buildRun.destinationType}
          onCompleted={refresh}
          onError={reportError}
          preferredDestination={item.buildRun.preferredDestination}
          size="sm"
        />
      )}
      {item.failureFingerprint && (
        <Button
          aria-label={
            compact ? t("acknowledgeNamed", { name: title }) : undefined
          }
          disabled={acknowledging}
          onClick={() => void acknowledgeFailure()}
          size={compact ? "icon-sm" : "sm"}
          title={compact ? t("acknowledge") : undefined}
          type="button"
          variant="outline"
        >
          {acknowledging ? <Spinner /> : <CheckCheck />}
          {!compact && t("acknowledge")}
        </Button>
      )}
    </div>
  );

  const worktree = item.worktree && (
    <Link
      className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
      href={`/worktrees/${item.worktree.id}`}
    >
      <GitBranch className="size-3 shrink-0" />
      <span className="truncate">{item.worktree.folder}</span>
      {item.worktree.branch && (
        <span className="truncate">· {item.worktree.branch}</span>
      )}
    </Link>
  );

  if (compact) {
    const question = item.questionBatches[0]?.questions[0];
    return (
      <div
        className={cn(
          "space-y-2 border-b border-l-4 p-2.5 last:border-b-0",
          color
            ? worktreeHighlightAccentClasses[color]
            : "border-l-transparent",
          color && worktreeHighlightBackgroundClasses[color],
        )}
      >
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <Link
              className="block truncate text-sm font-medium hover:underline"
              href={item.href}
            >
              {title}
            </Link>
            {item.resourceKind !== "WORKFLOW" && item.label !== title && (
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {item.label}
              </p>
            )}
          </div>
          <Badge
            className={cn("shrink-0 text-[10px]", reasonClass(item.reason))}
            variant={item.reason === "FAILED" ? "destructive" : "outline"}
          >
            {t(`reasons.${item.reason}`)}
          </Badge>
        </div>
        {question && (
          <p className="line-clamp-2 text-xs font-medium">
            {question.header || question.prompt}
          </p>
        )}
        {item.error && (
          <p className="line-clamp-2 text-xs text-destructive">{item.error}</p>
        )}
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">{worktree}</div>
          {actions}
        </div>
      </div>
    );
  }

  return (
    <Card
      className={cn(
        "border-l-4",
        color ? worktreeHighlightAccentClasses[color] : "border-l-transparent",
        color && worktreeHighlightBackgroundClasses[color],
      )}
    >
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 rounded-md border bg-background p-2">
              <Icon className="size-4" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">
                <Link className="hover:underline" href={item.href}>
                  {title}
                </Link>
              </CardTitle>
              <CardDescription className="mt-1 line-clamp-2">
                {item.resourceKind === "PLAN" || item.resourceKind === "SESSION"
                  ? item.label
                  : item.summary || item.label}
              </CardDescription>
            </div>
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={reasonClass(item.reason)}
            variant={item.reason === "FAILED" ? "destructive" : "outline"}
          >
            {t(`reasons.${item.reason}`)}
          </Badge>
          <Badge variant="secondary">{formatEnumLabel(item.status)}</Badge>
          {item.phase && item.phase !== item.status && (
            <Badge variant="outline">{formatEnumLabel(item.phase)}</Badge>
          )}
          <span className="text-xs text-muted-foreground">
            <DateTime value={item.updatedAt} />
          </span>
        </div>
        {worktree}
        {item.error && (
          <Alert variant="destructive">
            <AlertDescription>{item.error}</AlertDescription>
          </Alert>
        )}
        {item.questionBatches.map((batch) => (
          <ActionCenterQuestionForm batch={batch} item={item} key={batch.id} />
        ))}
      </CardContent>
    </Card>
  );
}
