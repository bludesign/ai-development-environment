"use client";

import { useState } from "react";
import { GitMerge } from "lucide-react";
import { useTranslations } from "next-intl";
import { MergePullRequestButton } from "@/components/github/merge-pull-request-button";
import { MergeRequestDialog } from "@/components/gitlab/merge-request-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatEnumLabel } from "@/lib/enum-label";
import type { ActionCenterItem } from "./types";
import { useActionCenter } from "./action-center-provider";

export function RequestStatus({
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
  if (!request) return null;
  const green = "bg-emerald-600 text-white hover:bg-emerald-700";
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-slot="action-center-request-status"
    >
      <Badge variant="outline">
        {request.provider === "GITHUB" ? "GitHub" : "GitLab"}
      </Badge>
      {request.pipelineUrl ? (
        <a href={request.pipelineUrl} target="_blank" rel="noreferrer">
          <Badge
            variant={
              /FAIL|ERROR/i.test(request.pipelineStatus)
                ? "destructive"
                : "outline"
            }
          >
            {t("pipeline")}: {formatEnumLabel(request.pipelineStatus)}
          </Badge>
        </a>
      ) : (
        <Badge variant="outline">
          {t("pipeline")}: {formatEnumLabel(request.pipelineStatus)}
        </Badge>
      )}
      <Badge variant="outline">
        {t("approval")}: {formatEnumLabel(request.approvalStatus)}
      </Badge>
      {compact && (
        <span className="w-full truncate text-xs text-muted-foreground">
          {request.repositoryName} · {request.branch}
        </span>
      )}
      {request.canMerge &&
        !request.draft &&
        (request.provider === "GITHUB" ? (
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
            className={green}
            onClick={() => setOpen(true)}
            size={compact ? "xs" : "sm"}
          >
            <GitMerge />
            {t("merge")}
          </Button>
        ))}
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
    </div>
  );
}
