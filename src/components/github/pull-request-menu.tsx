"use client";

import { ExternalLink, GitMerge, GitPullRequest } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { MergePullRequestButton } from "@/components/github/merge-pull-request-button";
import {
  githubMergeOperationKey,
  useMergeOperation,
} from "@/components/github/merge-operation-state";
import { pullRequestDetailHref } from "@/components/github/pull-request-links";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/i18n/navigation";
import { Spinner } from "@/components/ui/spinner";
import type { GitHubRequestSource } from "@/services/github/types";

type PullRequestMenuTarget = {
  number: number;
  repositoryNameWithOwner: string;
  url: string;
};

export function PullRequestMenu({
  label,
  pullRequest,
  requestSource,
}: {
  label: string;
  pullRequest: PullRequestMenuTarget;
  requestSource: GitHubRequestSource;
}) {
  const t = useTranslations("worktrees");
  const pullRequestsT = useTranslations("pullRequests");
  const [mergeOpen, setMergeOpen] = useState(false);
  const { pending: merging } = useMergeOperation(
    githubMergeOperationKey(pullRequest),
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Badge asChild className="cursor-pointer hover:bg-primary/80">
            <button aria-busy={merging} type="button">
              {merging && <Spinner aria-hidden="true" />}
              {label}
            </button>
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
          <DropdownMenuSeparator />
          <DropdownMenuItem
            aria-busy={merging}
            onSelect={() => setMergeOpen(true)}
          >
            {merging ? <Spinner aria-hidden="true" /> : <GitMerge />}
            {pullRequestsT(merging ? "merging" : "merge")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MergePullRequestButton
        onOpenChange={setMergeOpen}
        open={mergeOpen}
        pullRequest={pullRequest}
        requestSource={requestSource}
        showTrigger={false}
      />
    </>
  );
}
