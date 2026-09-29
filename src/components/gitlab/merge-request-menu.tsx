"use client";

import { ExternalLink, GitMerge, MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

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
};

export function MergeRequestMenu({
  label,
  mergeRequest,
  variant = "badge",
  onMerged,
}: {
  label: string;
  mergeRequest: MergeRequestMenuTarget;
  variant?: "badge" | "actions";
  onMerged?: () => void | Promise<void>;
}) {
  const gitLabT = useTranslations("gitlabPages");
  const worktreesT = useTranslations("worktrees");
  const [mergeOpen, setMergeOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {variant === "actions" ? (
            <Button
              aria-label={`${gitLabT("actions")}: !${mergeRequest.iid}`}
              size="icon-sm"
              variant="outline"
            >
              <MoreHorizontal />
            </Button>
          ) : (
            <Badge asChild className="cursor-pointer hover:bg-primary/80">
              <button type="button">{label}</button>
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
                  <DropdownMenuItem onSelect={() => setMergeOpen(true)}>
                    <GitMerge />
                    {gitLabT(
                      mergeRequest.state === "MERGED"
                        ? "mergeFollowUps"
                        : "mergeOptions",
                    )}
                  </DropdownMenuItem>
                </>
              )}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {mergeRequest.projectId ? (
        <MergeRequestDialog
          mergeRequest={{
            iid: mergeRequest.iid,
            projectId: mergeRequest.projectId,
            title: mergeRequest.title,
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
