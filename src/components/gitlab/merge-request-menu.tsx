"use client";

import { ExternalLink, GitMerge } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { MergeRequestDialog } from "@/components/gitlab/merge-request-dialog";
import { Badge } from "@/components/ui/badge";
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
};

export function MergeRequestMenu({
  label,
  mergeRequest,
}: {
  label: string;
  mergeRequest: MergeRequestMenuTarget;
}) {
  const gitLabT = useTranslations("gitlabPages");
  const worktreesT = useTranslations("worktrees");
  const [mergeOpen, setMergeOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Badge asChild className="cursor-pointer hover:bg-primary/80">
            <button type="button">{label}</button>
          </Badge>
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
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setMergeOpen(true)}>
                <GitMerge />
                {gitLabT("merge")}
              </DropdownMenuItem>
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
        />
      ) : null}
    </>
  );
}
