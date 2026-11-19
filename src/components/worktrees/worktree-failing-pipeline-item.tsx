"use client";

import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

import { useGitHubPipelineSnapshot } from "@/components/github/pipeline-status-provider";
import { WorkflowQuickActions } from "@/components/workflows/workflow-quick-actions";
import { cn } from "@/lib/utils";

import type { Worktree, WorktreeQuickAction } from "./types";
import {
  failingGitHubPipelines,
  failingGitLabPipelines,
  isFailingGitHubStatus,
} from "@/lib/worktree-failing-pipelines";

export function WorktreeFailingPipelineItem({
  worktree,
  workflows,
}: {
  worktree: Worktree;
  workflows?: WorktreeQuickAction[];
}) {
  if (!workflows?.length) return null;
  return <PipelineActions worktree={worktree} workflows={workflows} />;
}

function PipelineActions({
  worktree,
  workflows,
}: {
  worktree: Worktree;
  workflows: WorktreeQuickAction[];
}) {
  const t = useTranslations("worktrees");
  const { branch, headSha, pullRequest, sourceControlRequest } = worktree;
  const currentOpenPullRequest =
    pullRequest?.state === "OPEN" &&
    pullRequest.headRefName === branch &&
    pullRequest.headRefOid === headSha
      ? pullRequest
      : null;
  const seed = useMemo(() => {
    if (!currentOpenPullRequest) return null;
    return {
      repositoryGithubId: currentOpenPullRequest.repositoryGithubId,
      repositoryNameWithOwner: currentOpenPullRequest.repositoryNameWithOwner,
      repositoryUrl: currentOpenPullRequest.repositoryUrl,
      headSha: currentOpenPullRequest.headRefOid,
      pipelineStatus: currentOpenPullRequest.pipelineStatus,
      pipelines: currentOpenPullRequest.pipelines,
      revision: currentOpenPullRequest.pipelineRevision ?? 0,
      updatedAt: "",
    };
  }, [currentOpenPullRequest]);
  const github = useGitHubPipelineSnapshot(seed, seed);
  const gitlab =
    sourceControlRequest?.provider === "GITLAB" &&
    sourceControlRequest.state === "OPENED" &&
    sourceControlRequest.headRefName === branch &&
    sourceControlRequest.headRefOid === headSha
      ? failingGitLabPipelines(worktree.gitLabPipelines ?? [], worktree)
      : [];
  const failing =
    gitlab.length > 0 ||
    Boolean(github && isFailingGitHubStatus(github.pipelineStatus));

  return (
    <div
      className={cn(
        "empty:hidden",
        failing &&
          "space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3",
      )}
      data-worktree-navigation-ignore
    >
      {failing && (
        <p className="flex items-center gap-2 text-sm font-medium">
          <CircleAlert aria-hidden="true" className="size-4 text-destructive" />
          {t("pipelineFailing")}
        </p>
      )}
      <WorkflowQuickActions
        canLaunch={failing}
        sessionData={{
          worktree: {
            failingPipelines: [...failingGitHubPipelines(github), ...gitlab],
          },
        }}
        workflows={workflows}
        worktreeId={worktree.id}
      />
    </div>
  );
}
