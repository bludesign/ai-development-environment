"use client";

import { ChevronDown, ExternalLink, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { MouseEvent, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitHubPipelineState,
  GitHubPipelineStatus,
  GitHubPipelineView,
} from "@/services/github/types";

const PIPELINE_FIELDS = "id name status url checkSuiteId canRetry";

export function pipelineStateClass(
  status: GitHubPipelineState | GitHubPipelineStatus,
) {
  if (status === "SUCCESS")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (
    status === "PENDING" ||
    status === "EXPECTED" ||
    status === "QUEUED" ||
    status === "IN_PROGRESS" ||
    status === "ACTION_REQUIRED"
  )
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (
    status === "FAILURE" ||
    status === "ERROR" ||
    status === "CANCELLED" ||
    status === "STALE" ||
    status === "STARTUP_FAILURE" ||
    status === "TIMED_OUT"
  )
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
}

export function PipelineMenu({
  pipelineStatus,
  pipelines,
  repositoryId,
  onPipelineRetried,
}: {
  pipelineStatus: GitHubPipelineStatus;
  pipelines: GitHubPipelineView[];
  repositoryId: string;
  onPipelineRetried?: (pipeline: GitHubPipelineView) => void;
}) {
  const t = useTranslations("pullRequests");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stopPropagation = (event: MouseEvent) => event.stopPropagation();

  const retry = async (pipeline: GitHubPipelineView) => {
    if (!pipeline.checkSuiteId) return;
    setRetryingId(pipeline.id);
    try {
      const data = await controlPlaneRequest<{
        retryGitHubPipeline: GitHubPipelineView;
      }>(
        `mutation RetryGitHubPipeline(
          $repositoryId: ID!
          $checkSuiteId: ID!
        ) {
          retryGitHubPipeline(
            repositoryId: $repositoryId
            checkSuiteId: $checkSuiteId
          ) { ${PIPELINE_FIELDS} }
        }`,
        { repositoryId, checkSuiteId: pipeline.checkSuiteId },
      );
      onPipelineRetried?.(data.retryGitHubPipeline);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={`h-auto rounded-full px-2 py-0.5 text-xs ${pipelineStateClass(pipelineStatus)}`}
          onClick={stopPropagation}
          variant="outline"
        >
          {t(`pipelineStates.${pipelineStatus}`)}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80"
        onClick={stopPropagation}
      >
        <DropdownMenuLabel>{t("pipelineMenuTitle")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {error && (
          <p className="px-2 py-1.5 text-xs text-destructive">{error}</p>
        )}
        {pipelines.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {t("noPipelines")}
          </p>
        ) : (
          <div className="space-y-1 p-1">
            {pipelines.map((pipeline) => (
              <div
                key={pipeline.id}
                className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted"
              >
                <div className="min-w-0 flex-1">
                  {pipeline.url ? (
                    <a
                      className="flex min-w-0 items-center gap-1 text-sm font-medium hover:underline"
                      href={pipeline.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <span className="truncate">{pipeline.name}</span>
                      <ExternalLink className="size-3 shrink-0" />
                    </a>
                  ) : (
                    <p className="truncate text-sm font-medium">
                      {pipeline.name}
                    </p>
                  )}
                  <Badge
                    className={`mt-1 ${pipelineStateClass(pipeline.status)}`}
                  >
                    {t(`pipelineStates.${pipeline.status}`)}
                  </Badge>
                </div>
                {pipeline.canRetry && pipeline.checkSuiteId && (
                  <Button
                    disabled={retryingId !== null}
                    onClick={() => void retry(pipeline)}
                    size="sm"
                    variant="outline"
                  >
                    {retryingId === pipeline.id ? <Spinner /> : <RotateCcw />}
                    {retryingId === pipeline.id ? t("retrying") : t("retry")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
