"use client";

import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RotateCcw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { MouseEvent, useState } from "react";

import { pipelineStateClass } from "@/components/github/pipeline-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitHubWorkflowJobView } from "@/services/github/types";

export function WorkflowJob({
  job,
  repositoryId,
  checkSuiteId,
  onRetried,
  onError,
}: {
  job: GitHubWorkflowJobView;
  repositoryId: string;
  checkSuiteId: string | null;
  onRetried: () => void;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("pullRequestDetail");
  const tp = useTranslations("pullRequests");
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          aria-expanded={expanded}
          aria-label={t(expanded ? "hideJobSteps" : "showJobSteps", {
            job: job.name,
          })}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? (
            <ChevronDown className="size-4 shrink-0" />
          ) : (
            <ChevronRight className="size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {job.name}
          </span>
          <Badge className={pipelineStateClass(job.status)}>
            {tp(`pipelineStates.${job.status}`)}
          </Badge>
        </button>
        {job.url && (
          <Button asChild size="sm" variant="outline">
            <a
              aria-label={t("viewJob", { job: job.name })}
              href={job.url}
              rel="noreferrer"
              target="_blank"
            >
              {t("viewPipeline")}
              <ExternalLink />
            </a>
          </Button>
        )}
        <RetryWorkflowJobButton
          checkSuiteId={checkSuiteId}
          job={job}
          onError={onError}
          onRetried={onRetried}
          repositoryId={repositoryId}
        />
      </div>
      {expanded && (
        <div className="mb-3 w-full rounded-md border bg-background p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("steps")}
          </p>
          {job.steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noSteps")}</p>
          ) : (
            <ol className="space-y-2">
              {job.steps.map((step) => (
                <li
                  className="flex items-center gap-3 text-sm"
                  key={step.number}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">
                    {step.number}
                  </span>
                  <span className="min-w-0 flex-1">{step.name}</span>
                  <Badge className={pipelineStateClass(step.status)}>
                    {tp(`pipelineStates.${step.status}`)}
                  </Badge>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function RetryWorkflowJobButton({
  job,
  repositoryId,
  checkSuiteId,
  onRetried,
  onError,
}: {
  job: GitHubWorkflowJobView;
  repositoryId: string;
  checkSuiteId: string | null;
  onRetried: () => void;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("pullRequestDetail");
  const tp = useTranslations("pullRequests");
  const [retrying, setRetrying] = useState(false);

  const retry = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!job.canRetry || !checkSuiteId) return;
    setRetrying(true);
    try {
      await controlPlaneRequest<{ retryGitHubWorkflowJob: boolean }>(
        `mutation RetryGitHubWorkflowJob(
          $repositoryId: ID!
          $checkSuiteId: ID!
          $jobId: ID!
        ) {
          retryGitHubWorkflowJob(
            repositoryId: $repositoryId
            checkSuiteId: $checkSuiteId
            jobId: $jobId
          )
        }`,
        { repositoryId, checkSuiteId, jobId: job.id },
      );
      onRetried();
      onError(null);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      setRetrying(false);
    }
  };

  const unavailableMessage = job.retryUnavailableReason
    ? tp(`retryUnavailable.${job.retryUnavailableReason}`)
    : undefined;
  return (
    <Button
      aria-label={t("retryJob", { job: job.name })}
      disabled={retrying || !job.canRetry || !checkSuiteId}
      onClick={(event) => void retry(event)}
      size="sm"
      title={unavailableMessage}
      variant="outline"
    >
      {retrying ? <Spinner /> : <RotateCcw />}
      {retrying ? tp("retrying") : tp("retry")}
    </Button>
  );
}
