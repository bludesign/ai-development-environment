"use client";

import { DateTime } from "@/components/common/date-time";
import { useRunLabels } from "@/components/runs/run-labels";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { formatEnumLabel } from "@/lib/enum-label";
import { useTranslations } from "next-intl";

import type { WorktreeRunQueueEntry } from "./types";

function entryHref(entry: WorktreeRunQueueEntry): string {
  if (entry.kind === "WORKFLOW") return `/workflows/runs/${entry.id}`;
  return `/${entry.kind === "PLAN" ? "plans" : "sessions"}/${entry.id}`;
}

export function WorktreeRunQueueCard({
  currentEntryId,
  entries,
  scope,
}: {
  currentEntryId?: string;
  entries: WorktreeRunQueueEntry[];
  scope: "RUN" | "WORKFLOW" | "WORKTREE";
}) {
  const t = useTranslations("workflows");
  const kindT = useTranslations("actionCenter.kinds");
  const runLabels = useRunLabels();
  const showWorktree = scope === "WORKFLOW";

  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-0">
      <CardHeader>
        <CardTitle>
          {scope === "WORKTREE" ? t("worktreeQueue") : t("workflowQueue")}
        </CardTitle>
        <CardDescription>
          {scope === "WORKTREE"
            ? t("worktreeQueueDescription")
            : scope === "RUN"
              ? t("runQueueDescription")
              : t("workflowQueueDescription")}
        </CardDescription>
      </CardHeader>
      {!entries.length ? (
        <CardContent className="pb-6">
          <Empty className="border py-8">
            <EmptyHeader>
              <EmptyTitle>{t("queueEmpty")}</EmptyTitle>
              <EmptyDescription>{t("queueEmptyDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      ) : (
        <div className="overflow-x-auto border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">{t("queuePosition")}</TableHead>
                <TableHead>{t("queueItem")}</TableHead>
                <TableHead>{t("queueState")}</TableHead>
                {showWorktree && <TableHead>{t("queueWorktree")}</TableHead>}
                <TableHead>{t("queuedAt")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const current = entry.id === currentEntryId;
                return (
                  <TableRow
                    className={current ? "bg-primary/5" : undefined}
                    key={`${entry.kind}:${entry.id}`}
                  >
                    <TableCell className="font-mono font-semibold">
                      #{entry.position}
                    </TableCell>
                    <TableCell>
                      <Link
                        className="font-medium hover:underline"
                        href={entryHref(entry)}
                      >
                        {kindT(entry.kind)} #{entry.displayNumber}
                      </Link>
                      <p className="max-w-72 truncate text-xs text-muted-foreground">
                        {entry.name}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="outline">
                          {entry.kind === "WORKFLOW"
                            ? formatEnumLabel(entry.phase)
                            : runLabels.phase(entry.phase)}
                        </Badge>
                        {entry.exclusiveWorktree && (
                          <Badge variant="secondary">{t("exclusive")}</Badge>
                        )}
                        {current && (
                          <Badge variant="secondary">{t("currentRun")}</Badge>
                        )}
                      </div>
                    </TableCell>
                    {showWorktree && (
                      <TableCell>
                        {entry.worktree ? (
                          <Link
                            className="font-mono text-xs hover:underline"
                            href={`/worktrees/${entry.worktree.id}`}
                          >
                            {entry.worktree.branch ?? entry.worktree.folder}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-muted-foreground">
                      <DateTime kind="relative" value={entry.queuedAt} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}
