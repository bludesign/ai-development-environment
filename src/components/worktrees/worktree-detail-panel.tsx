"use client";

import { useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import type { WorktreeDetail } from "./types";

export function WorktreeDetailPanel({
  detail,
  inline = false,
}: {
  detail: WorktreeDetail;
  inline?: boolean;
}) {
  const t = useTranslations("worktrees");
  const locale = useLocale();
  return (
    <div
      className={cn("w-full space-y-4", inline && "border-t pt-4")}
      data-testid="worktree-detail"
      data-worktree-navigation-ignore={inline ? "true" : undefined}
    >
      <section className="w-full">
        <h2 className="mb-2 font-medium">
          {t("changes", { count: detail.changes.length })}
        </h2>
        <div
          className={cn(
            "overflow-auto rounded-md border",
            inline && "max-h-80",
          )}
        >
          {detail.changes.length ? (
            <Table
              aria-label={t("changes", { count: detail.changes.length })}
              className="min-w-[36rem] table-fixed text-xs"
            >
              <TableBody>
                {detail.changes.map((change) => (
                  <TableRow key={change.path}>
                    <TableCell className="max-w-0 px-2 py-1.5 font-mono">
                      <span className="block truncate" title={change.path}>
                        {change.path}
                      </span>
                    </TableCell>
                    <TableCell className="w-px px-2 py-1.5">
                      <div className="flex items-center justify-end gap-2">
                        {change.conflicted && (
                          <Badge className="px-1.5" variant="destructive">
                            {t("conflicted")}
                          </Badge>
                        )}
                        {change.staged && (
                          <ChangeState
                            additions={change.stagedAdditions}
                            deletions={change.stagedDeletions}
                            label={t("staged")}
                          />
                        )}
                        {change.unstaged && (
                          <ChangeState
                            additions={change.unstagedAdditions}
                            deletions={change.unstagedDeletions}
                            label={t("unstaged")}
                          />
                        )}
                        {change.untracked && (
                          <ChangeState
                            additions={change.unstagedAdditions}
                            deletions={change.unstagedDeletions}
                            label={t("untracked")}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t("noChanges")}
            </p>
          )}
        </div>
      </section>
      <section className="w-full">
        <h2 className="mb-2 font-medium">
          {t("commits", { count: detail.commits.length })}
        </h2>
        <div
          className={cn(
            "overflow-auto rounded-md border",
            inline && "max-h-80",
          )}
        >
          {detail.commits.length ? (
            <Table
              aria-label={t("commits", { count: detail.commits.length })}
              className="min-w-[36rem] table-fixed text-xs"
            >
              <TableBody>
                {detail.commits.map((commit) => (
                  <TableRow key={commit.sha}>
                    <TableCell className="w-24 px-2 py-1.5 font-mono text-muted-foreground">
                      {commit.sha.slice(0, 8)}
                    </TableCell>
                    <TableCell className="max-w-0 px-2 py-1.5">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate font-medium">
                          {commit.subject}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {commit.authorName} ·{" "}
                          {new Date(commit.authoredAt).toLocaleString(locale)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="w-24 px-2 py-1.5 text-right">
                      <LineCounts
                        additions={commit.additions}
                        deletions={commit.deletions}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t("noCommits")}
            </p>
          )}
        </div>
      </section>
      {(detail.commitsTruncated || detail.changesTruncated) && (
        <p className="text-xs text-muted-foreground">{t("truncated")}</p>
      )}
    </div>
  );
}

function ChangeState({
  label,
  additions,
  deletions,
}: {
  label: string;
  additions: number | null;
  deletions: number | null;
}) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">
      <span>{label}</span>
      <LineCounts additions={additions} deletions={deletions} />
    </span>
  );
}

function LineCounts({
  additions,
  deletions,
}: {
  additions: number | null;
  deletions: number | null;
}) {
  if (additions === null && deletions === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex gap-1 tabular-nums">
      <span className="text-emerald-700 dark:text-emerald-400">
        +{additions ?? 0}
      </span>
      <span className="text-red-700 dark:text-red-400">−{deletions ?? 0}</span>
    </span>
  );
}
