"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  MergeOperationLabel,
  MergeOperationIcon,
} from "@/components/github/post-merge-switch-client";
import { MergeOperationError } from "@/components/github/merge-operation-error";
import { gitlabMergeOperationKey } from "@/components/github/merge-operation-state";
import { MergePullRequestButton } from "@/components/github/merge-pull-request-button";
import { MergeRequestDialog } from "@/components/gitlab/merge-request-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatEnumLabel } from "@/lib/enum-label";
import { cn } from "@/lib/utils";
import type { ActionCenterItem } from "./types";
import { useActionCenter } from "./action-center-provider";

function approvalBadge(status: string) {
  switch (status.toUpperCase()) {
    case "APPROVED":
      return { label: "approved", variant: "success" } as const;
    case "NONE":
    case "NOT_REQUIRED":
      return { label: "noDecision", variant: "outline" } as const;
    case "CHANGES_REQUESTED":
      return { label: "changesRequested", variant: "destructive" } as const;
    case "REVIEW_REQUIRED":
    case "NOT_APPROVED":
    case "PENDING":
    case "DISMISSED":
      return { label: "notApproved", variant: "outline" } as const;
    default:
      return { label: "approvalUnknown", variant: "outline" } as const;
  }
}

export function RequestStatus({
  item,
  compact = false,
  children,
}: {
  item: ActionCenterItem;
  compact?: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations("actionCenter");
  const request = item.request;
  if (!request) return null;
  const approval = approvalBadge(request.approvalStatus);
  const pipelineVariant =
    request.pipelineStatus === "SUCCESS"
      ? "success"
      : /FAIL|ERROR|CANCEL|TIMED_OUT/i.test(request.pipelineStatus)
        ? "destructive"
        : "outline";
  const warning =
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  const badgeClassName = compact
    ? "h-4 px-1.5 py-0 text-[9px] leading-none"
    : undefined;
  const pipeline = (
    <Badge
      className={cn(badgeClassName, pipelineVariant === "outline" && warning)}
      variant={pipelineVariant}
    >
      {formatEnumLabel(request.pipelineStatus)}
    </Badge>
  );
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-slot="action-center-request-status"
    >
      {request.pipelineUrl ? (
        <a
          className="inline-flex shrink-0 items-center"
          href={request.pipelineUrl}
          target="_blank"
          rel="noreferrer"
        >
          {pipeline}
        </a>
      ) : (
        pipeline
      )}
      <Badge
        className={cn(
          badgeClassName,
          approval.label === "notApproved" && warning,
        )}
        variant={approval.variant}
      >
        {t(approval.label)}
      </Badge>
      {children}
      {(request.needsRebase || (request.behindCount ?? 0) > 0) && (
        <Badge variant="outline" className={cn(badgeClassName, warning)}>
          {t(request.needsRebase ? "needsRebase" : "behindTarget")}
        </Badge>
      )}
    </div>
  );
}

export function RequestMergeAction({
  item,
  compact = false,
}: {
  item: ActionCenterItem;
  compact?: boolean;
}) {
  const t = useTranslations("actionCenter");
  const { refreshRequests } = useActionCenter();
  const [open, setOpen] = useState(false);
  const request = item.request;
  if (!request?.canMerge || request.draft) return null;

  return (
    <>
      {request.provider === "GITHUB" ? (
        <span className="[&_button]:bg-emerald-600 [&_button]:text-white [&_button]:hover:bg-emerald-700">
          <MergePullRequestButton
            pullRequest={{
              number: request.number,
              repositoryNameWithOwner: request.repositoryName,
            }}
            requestSource="PULL_REQUESTS_PAGE"
            worktreeId={item.worktree?.id}
            onMerged={async () => {
              await refreshRequests();
            }}
            size={compact ? "xs" : "sm"}
          />
        </span>
      ) : (
        <Button
          className="bg-emerald-600 text-white hover:bg-emerald-700"
          onClick={() => setOpen(true)}
          size={compact ? "xs" : "sm"}
        >
          <MergeOperationIcon
            operationKey={gitlabMergeOperationKey({
              projectId: request.repositoryId,
              iid: request.number,
            })}
          />
          <MergeOperationLabel
            operationKey={gitlabMergeOperationKey({
              projectId: request.repositoryId,
              iid: request.number,
            })}
            idleLabel={t("merge")}
            pendingLabel={t("merge")}
          />
        </Button>
      )}
      {request.provider === "GITLAB" && !open && (
        <MergeOperationError
          operationKey={gitlabMergeOperationKey({
            projectId: request.repositoryId,
            iid: request.number,
          })}
          onOpen={() => setOpen(true)}
        />
      )}
      {request.provider === "GITLAB" && (
        <MergeRequestDialog
          mergeRequest={{
            projectId: request.repositoryId,
            iid: request.number,
            title: item.label,
          }}
          worktreeId={item.worktree?.id}
          open={open}
          onOpenChange={setOpen}
          onMerged={async () => {
            await refreshRequests();
          }}
        />
      )}
    </>
  );
}
