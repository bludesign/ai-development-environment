"use client";

import { ExternalLink, GitMerge } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/i18n/navigation";

type MergeRequestMenuTarget = {
  iid: number;
  projectId?: string | null;
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

  return (
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
          <DropdownMenuItem asChild>
            <Link
              href={`/gitlab/merge-requests/${encodeURIComponent(mergeRequest.projectId)}/${mergeRequest.iid}`}
            >
              <GitMerge />
              {worktreesT("openDetails")}
            </Link>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
