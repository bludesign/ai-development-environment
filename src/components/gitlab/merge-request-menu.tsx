"use client";

import { ExternalLink, GitMerge, MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { MergeOperationError } from "@/components/github/merge-operation-error";
import {
  MergeOperationLabel,
  MergeOperationIcon,
  usePostMergeSwitchRecovery,
} from "@/components/github/post-merge-switch-client";
import {
  gitlabMergeOperationKey,
  useMergeOperation,
} from "@/components/github/merge-operation-state";
import { MergeRequestDialog } from "@/components/gitlab/merge-request-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/i18n/navigation";

type MergeRequestMenuTarget = {
  iid: number;
  projectId?: string | null;
  title: string;
  webUrl: string;
  state?: string;
  worktreeId?: string | null;
  mergeOperation?: { postMergeSwitch?: unknown } | null;
};

export function MergeRequestMenu({
  label,
  mergeRequest,
  variant = "badge",
  onMerged,
  onMergeOptions,
}: {
  label: string;
  mergeRequest: MergeRequestMenuTarget;
  variant?: "badge" | "actions";
  onMerged?: () => void | Promise<void>;
  onMergeOptions?: () => void;
}) {
  const gitLabT = useTranslations("gitlabPages");
  const worktreesT = useTranslations("worktrees");
  const [mergeOpen, setMergeOpen] = useState(false);
  const operationKey = gitlabMergeOperationKey({
    projectId: mergeRequest.projectId ?? "",
    iid: mergeRequest.iid,
  });
  const { pending } = useMergeOperation(operationKey);
  usePostMergeSwitchRecovery(
    operationKey,
    {
      provider: "gitlab",
      projectId: mergeRequest.projectId ?? "",
      iid: mergeRequest.iid,
    },
    Boolean(mergeRequest.projectId) &&
      (mergeRequest.state === "MERGED" ||
        Boolean(mergeRequest.mergeOperation?.postMergeSwitch)),
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {variant === "actions" ? (
            <Button
              aria-label={`${gitLabT("actions")}: !${mergeRequest.iid}`}
              aria-busy={pending}
              size="icon-sm"
              variant="outline"
            >
              <MergeOperationIcon operationKey={operationKey}>
                <MoreHorizontal />
              </MergeOperationIcon>
            </Button>
          ) : (
            <Badge asChild className="cursor-pointer hover:bg-primary/80">
              <button aria-busy={pending} type="button">
                <MergeOperationIcon operationKey={operationKey}>
                  {null}
                </MergeOperationIcon>
                {label}
              </button>
            </Badge>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem asChild>
            <a href={mergeRequest.webUrl} rel="noreferrer" target="_blank">
              <ExternalLink />
              {gitLabT("openInGitLab")}
            </a>
          </DropdownMenuItem>
          {mergeRequest.projectId ? (
            <>
              <DropdownMenuItem asChild>
                <Link
                  href={`/gitlab/merge-requests/${encodeURIComponent(mergeRequest.projectId)}/${mergeRequest.iid}`}
                >
                  <GitMerge />
                  {worktreesT("openDetails")}
                </Link>
              </DropdownMenuItem>
              {(mergeRequest.state == null ||
                mergeRequest.state === "OPENED" ||
                mergeRequest.state === "MERGED") && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      onMergeOptions ? onMergeOptions() : setMergeOpen(true)
                    }
                  >
                    <MergeOperationIcon operationKey={operationKey} />
                    <MergeOperationLabel
                      operationKey={operationKey}
                      idleLabel={gitLabT(
                        mergeRequest.state === "MERGED"
                          ? "mergeFollowUps"
                          : "mergeOptions",
                      )}
                      pendingLabel={gitLabT("mergeOptions")}
                    />
                  </DropdownMenuItem>
                </>
              )}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {mergeRequest.projectId && !mergeOpen && (
        <MergeOperationError
          operationKey={gitlabMergeOperationKey({
            projectId: mergeRequest.projectId,
            iid: mergeRequest.iid,
          })}
          onOpen={() =>
            onMergeOptions ? onMergeOptions() : setMergeOpen(true)
          }
        />
      )}
      {mergeRequest.projectId && !onMergeOptions ? (
        <MergeRequestDialog
          mergeRequest={{
            iid: mergeRequest.iid,
            projectId: mergeRequest.projectId,
            title: mergeRequest.title,
            state: mergeRequest.state,
          }}
          onOpenChange={setMergeOpen}
          open={mergeOpen}
          worktreeId={mergeRequest.worktreeId}
          onMerged={onMerged}
        />
      ) : null}
    </>
  );
}
