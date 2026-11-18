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
} from "./worktree-failing-pipelines";

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
  const { pullRequest } = worktree;
  const seed = useMemo(
    () =>
      pullRequest?.headRefOid
        ? {
            repositoryGithubId: pullRequest.repositoryGithubId,
            repositoryNameWithOwner: pullRequest.repositoryNameWithOwner,
            repositoryUrl: pullRequest.repositoryUrl,
            headSha: pullRequest.headRefOid,
            pipelineStatus: pullRequest.pipelineStatus,
            pipelines: pullRequest.pipelines,
            revision: pullRequest.pipelineRevision ?? 0,
            updatedAt: "",
          }
        : null,
    [pullRequest],
  );
  const github = useGitHubPipelineSnapshot(seed, seed);
  const gitlab = failingGitLabPipelines(
    worktree.gitLabPipelines ?? [],
    worktree.headSha,
  );
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
