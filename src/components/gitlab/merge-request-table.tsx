"use client";

import { useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { worktreeDetailHref } from "@/components/worktrees/worktree-navigation";
import { Link, useRouter } from "@/i18n/navigation";
import { isRowActivation } from "@/lib/row-activation";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightBackgroundClasses,
  worktreeHighlightInsetAccentClasses,
} from "@/lib/worktree-highlight";
import type {
  GitLabMergeRequestView,
  GitLabProjectView,
} from "@/services/gitlab";

import { MergeRequestMenu } from "./merge-request-menu";
import {
  GitLabApprovalBadge,
  GitLabMergeReadinessBadge,
  GitLabMergeRequestStateBadge,
  gitLabMergeRequestHref,
  gitLabStatusColors,
} from "./merge-request-status";
import { GitLabPipelineStatusBadge } from "./pipeline-status-badge";

export function GitLabMergeRequestTable({
  items,
  projects,
  onChanged,
  onTicket,
}: {
  items: GitLabMergeRequestView[];
  projects: GitLabProjectView[];
  onChanged: () => Promise<void>;
  onTicket: (key: string) => void;
}) {
  const t = useTranslations("gitlabPages");
  const router = useRouter();
  return (
    <Card className="min-w-0 gap-0 py-0">
      <Table aria-label={t("mergeRequestsTitle")}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {[
              "number",
              "mergeRequestAndProject",
              "labels",
              "ticket",
              "pipeline",
              "approval",
              "openDiscussions",
              "age",
              "actions",
            ].map((key) => (
              <TableHead key={key}>{t(key)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((mr) => {
            const href = gitLabMergeRequestHref(mr);
            const project = projects.find((item) => item.id === mr.projectId);
            const highlight = mr.worktreeHighlightColor;
            const discussions = mr.unresolvedDiscussionsCount;
            return (
              <TableRow
                key={mr.id}
                className={cn(
                  "cursor-pointer",
                  highlight && worktreeHighlightBackgroundClasses[highlight],
                )}
                onClick={(event) => {
                  if (isRowActivation(event)) router.push(href);
                }}
              >
                <TableCell
                  className={cn(
                    highlight && worktreeHighlightInsetAccentClasses[highlight],
                  )}
                >
                  <Badge asChild variant="outline">
                    <Link href={href}>!{mr.iid}</Link>
                  </Badge>
                </TableCell>
                <TableCell className="min-w-72 whitespace-normal">
                  <div className="space-y-1.5">
                    <Link className="font-medium hover:underline" href={href}>
                      {mr.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {mr.projectPath ??
                        project?.pathWithNamespace ??
                        mr.projectId}{" "}
                      · @{mr.author.username}
                    </p>
                    <p className="font-mono text-xs break-all text-muted-foreground">
                      {mr.sourceBranch} → {mr.targetBranch}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {mr.draft && (
                        <Badge variant="secondary">{t("draft")}</Badge>
                      )}
                      <GitLabMergeReadinessBadge
                        state={mr.state}
                        status={mr.detailedMergeStatus}
                        hasConflicts={mr.hasConflicts}
                      />
                      {mr.mergeWhenPipelineSucceeds &&
                        mr.state === "OPENED" && (
                          <Badge className={gitLabStatusColors.warning}>
                            {t("autoMergeEnabled")}
                          </Badge>
                        )}
                      {mr.worktreeId && (
                        <Badge asChild variant="outline">
                          <Link href={worktreeDetailHref(mr.worktreeId)}>
                            {t("viewWorktree")}
                          </Link>
                        </Badge>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="min-w-32 whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {mr.labels.length
                      ? mr.labels.map((label) => (
                          <Badge key={label} variant="secondary">
                            {label}
                          </Badge>
                        ))
                      : "—"}
                  </div>
                </TableCell>
                <TableCell>
                  {mr.ticketKey ? (
                    <Badge asChild>
                      <button
                        type="button"
                        onClick={() => onTicket(mr.ticketKey!)}
                      >
                        {mr.ticketKey}
                      </button>
                    </Badge>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  {mr.headPipeline ? (
                    <Link href={`${href}#pipelines`}>
                      <GitLabPipelineStatusBadge
                        status={mr.headPipeline.status}
                      />
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {t("unavailable")}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <GitLabApprovalBadge state={mr.approvalState} />
                </TableCell>
                <TableCell>
                  <Badge
                    asChild
                    className={
                      discussions == null
                        ? gitLabStatusColors.neutral
                        : discussions === 0
                          ? gitLabStatusColors.success
                          : gitLabStatusColors.warning
                    }
                  >
                    <Link
                      href={`${href}#discussions`}
                      aria-label={
                        discussions == null
                          ? t("discussionsUnavailable")
                          : t("viewOpenDiscussions", { count: discussions })
                      }
                    >
                      {discussions ?? "—"}
                    </Link>
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1.5">
                    <GitLabMergeRequestStateBadge
                      state={mr.state}
                      draft={mr.draft}
                    />
                    <DateTime kind="relative" value={mr.createdAt} />
                  </div>
                </TableCell>
                <TableCell>
                  <MergeRequestMenu
                    label={`!${mr.iid}`}
                    mergeRequest={mr}
                    onMerged={onChanged}
                    variant="actions"
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
