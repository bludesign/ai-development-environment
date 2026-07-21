"use client";

import {
  Ban,
  CircleStop,
  ExternalLink,
  GitBranch,
  List,
  MoreHorizontal,
  RotateCcw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { AutoRetryDialog } from "@/components/github/auto-retry-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitHubActionsWorkflowRunView,
  GitHubPipelineState,
  GitHubWorkflowJobView,
} from "@/services/github/types";
import { worktreeDetailHref } from "@/components/worktrees/worktree-navigation";

const CANCELLABLE_RUN_STATES = new Set<GitHubPipelineState>([
  "ACTION_REQUIRED",
  "EXPECTED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
]);

export function actionsForBranchHref(
  repositoryId: string,
  branch: string,
  workflowId?: string | null,
) {
  const params = new URLSearchParams({ repository: repositoryId, branch });
  if (workflowId) params.set("pipeline", workflowId);
  return `/actions?${params.toString()}`;
}

type WorkflowRunMenuRun = Omit<
  Pick<
    GitHubActionsWorkflowRunView,
    | "id"
    | "workflowId"
    | "repositoryGithubId"
    | "name"
    | "displayTitle"
    | "status"
    | "url"
    | "checkSuiteId"
    | "canRetry"
    | "retryUnavailableReason"
  >,
  "url"
> & {
  url: string | null;
  codebaseRepositoryId: string | null;
  worktreeId?: string | null;
};

export function WorkflowRunActionsMenu({
  run,
  jobs = [],
  includeAutoRetry = false,
  includeWorktree = false,
  onCancelled,
  onRetried,
  onError,
  viewAllHref,
}: {
  run: WorkflowRunMenuRun;
  jobs?: GitHubWorkflowJobView[];
  includeAutoRetry?: boolean;
  includeWorktree?: boolean;
  onCancelled: () => void;
  onRetried: () => void;
  onError: (error: string | null) => void;
  viewAllHref?: string | null;
}) {
  const t = useTranslations("actionsPage");
  const td = useTranslations("pullRequestDetail");
  const tp = useTranslations("pullRequests");
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState<"cancel" | "force" | null>(null);
  const [confirmingForceCancel, setConfirmingForceCancel] = useState(false);

  const retry = async () => {
    if (!run.canRetry || !run.checkSuiteId) return;
    setRetrying(true);
    try {
      await controlPlaneRequest<{ retryGitHubPipeline: { id: string } }>(
        `mutation RetryGitHubPipeline(
          $repositoryId: ID!
          $checkSuiteId: ID!
        ) {
          retryGitHubPipeline(
            repositoryId: $repositoryId
            checkSuiteId: $checkSuiteId
          ) { id }
        }`,
        {
          repositoryId: run.repositoryGithubId,
          checkSuiteId: run.checkSuiteId,
        },
      );
      onRetried();
      onError(null);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      setRetrying(false);
    }
  };

  const cancelRun = async (force: boolean) => {
    if (
      !run.codebaseRepositoryId ||
      !CANCELLABLE_RUN_STATES.has(run.status) ||
      cancelling
    ) {
      return;
    }
    setCancelling(force ? "force" : "cancel");
    try {
      await controlPlaneRequest<{
        cancelGitHubActionsWorkflowRun: boolean;
      }>(
        `mutation CancelGitHubActionsWorkflowRun(
          $codebaseRepositoryId: ID!
          $workflowRunId: ID!
          $force: Boolean!
        ) {
          cancelGitHubActionsWorkflowRun(
            codebaseRepositoryId: $codebaseRepositoryId
            workflowRunId: $workflowRunId
            force: $force
          )
        }`,
        {
          codebaseRepositoryId: run.codebaseRepositoryId,
          workflowRunId: run.id,
          force,
        },
      );
      onCancelled();
      onError(null);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      setCancelling(null);
    }
  };

  const retryUnavailableMessage = run.retryUnavailableReason
    ? tp(`retryUnavailable.${run.retryUnavailableReason}`)
    : undefined;
  const cancellable =
    Boolean(run.codebaseRepositoryId) && CANCELLABLE_RUN_STATES.has(run.status);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`${t("actions")}: ${run.displayTitle}`}
            size="icon-sm"
            variant="outline"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {run.url ? (
            <DropdownMenuItem asChild>
              <a href={run.url} rel="noreferrer" target="_blank">
                <ExternalLink />
                {t("view")}
              </a>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>
              <ExternalLink />
              {t("view")}
            </DropdownMenuItem>
          )}
          {viewAllHref ? (
            <DropdownMenuItem asChild>
              <Link href={viewAllHref}>
                <List />
                {td("viewAll")}
              </Link>
            </DropdownMenuItem>
          ) : null}
          {includeWorktree ? (
            run.worktreeId ? (
              <DropdownMenuItem asChild>
                <Link href={worktreeDetailHref(run.worktreeId)}>
                  <GitBranch />
                  {t("worktree")}
                </Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                <GitBranch />
                {t("worktree")}
              </DropdownMenuItem>
            )
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={Boolean(cancelling) || !cancellable}
            onSelect={() => void cancelRun(false)}
          >
            {cancelling === "cancel" ? <Spinner /> : <CircleStop />}
            {cancelling === "cancel" ? t("cancelling") : t("cancel")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={Boolean(cancelling) || !cancellable}
            onSelect={() => setConfirmingForceCancel(true)}
            variant="destructive"
          >
            {cancelling === "force" ? <Spinner /> : <Ban />}
            {cancelling === "force" ? t("forceCancelling") : t("forceCancel")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={retrying || !run.canRetry || !run.checkSuiteId}
            onSelect={() => void retry()}
            title={retryUnavailableMessage}
          >
            {retrying ? <Spinner /> : <RotateCcw />}
            {retrying ? tp("retrying") : tp("retry")}
          </DropdownMenuItem>
          {includeAutoRetry && run.codebaseRepositoryId ? (
            <AutoRetryDialog
              codebaseRepositoryId={run.codebaseRepositoryId}
              currentRuns={[
                {
                  id: run.id,
                  workflowId: run.workflowId,
                  name: run.name,
                  jobs,
                },
              ]}
              repositoryGithubId={run.repositoryGithubId}
              trigger={
                <DropdownMenuItem onSelect={(event) => event.preventDefault()}>
                  <RotateCcw />
                  {t("autoRetry")}
                </DropdownMenuItem>
              }
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmationDialog
        actionLabel={t("forceCancel")}
        cancelLabel={t("keepRunning")}
        description={t("forceCancelDescription")}
        onConfirm={() => cancelRun(true)}
        onOpenChange={setConfirmingForceCancel}
        open={confirmingForceCancel}
        title={t("forceCancelTitle")}
      />
    </>
  );
}
