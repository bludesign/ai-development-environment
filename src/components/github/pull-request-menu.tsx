"use client";

import { ExternalLink, GitPullRequest } from "lucide-react";
import { useTranslations } from "next-intl";

import { pullRequestDetailHref } from "@/components/github/pull-request-links";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/i18n/navigation";

type PullRequestMenuTarget = {
  number: number;
  repositoryNameWithOwner: string;
  url: string;
};

export function PullRequestMenu({
  label,
  pullRequest,
}: {
  label: string;
  pullRequest: PullRequestMenuTarget;
}) {
  const t = useTranslations("worktrees");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge asChild className="cursor-pointer hover:bg-primary/80">
          <button type="button">{label}</button>
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuItem asChild>
          <a href={pullRequest.url} rel="noreferrer" target="_blank">
            <ExternalLink />
            {t("openInGitHub")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={pullRequestDetailHref(pullRequest)}>
            <GitPullRequest />
            {t("openDetails")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
