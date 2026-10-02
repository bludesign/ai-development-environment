"use client";

import { ChevronDown, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { type MouseEvent, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitLabPipelineView } from "@/services/gitlab";

import {
  GitLabPipelineSource,
  GitLabPipelineStatusBadge,
} from "./pipeline-status-badge";

import {
  aggregateGitLabPipelineStatus,
  gitLabPipelineStatusClass,
} from "./pipeline-format";

export function GitLabWorktreePipelinesMenu({
  pipelines,
  onChanged,
}: {
  pipelines: GitLabPipelineView[];
  onChanged?: () => Promise<void>;
}) {
  const t = useTranslations("gitlabPages");
  const tp = useTranslations("pullRequests");
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const actionInFlight = useRef(false);
  if (!pipelines.length) return null;

  const status = aggregateGitLabPipelineStatus(
    pipelines.map((pipeline) => pipeline.status),
  );
  const stopPropagation = (event: MouseEvent) => event.stopPropagation();
  const retry = async (pipeline: GitLabPipelineView) => {
    if (actionInFlight.current || !pipeline.canRetry) return;
    actionInFlight.current = true;
    setRetrying(pipeline.id);
    setError(null);
    setMessage(null);
    try {
      const data = await controlPlaneRequest<{
        runGitLabPipelineAction: {
          execution: { status: string; message: string | null } | null;
        };
      }>(
        "mutation GitLabWorktreePipelineRetry($projectId: ID!, $pipelineId: ID!) { runGitLabPipelineAction(projectId: $projectId, pipelineId: $pipelineId, action: RETRY) { pipeline { id } execution { id status message } } }",
        { projectId: pipeline.projectId, pipelineId: pipeline.id },
      );
      const execution = data.runGitLabPipelineAction.execution;
      if (execution) {
        const result = `${execution.status}: ${execution.message ?? ""}`;
        if (["FAILED", "PARTIAL", "UNCERTAIN"].includes(execution.status))
          setError(result);
        else setMessage(result);
      }
      await onChanged?.();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      actionInFlight.current = false;
      setRetrying(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`${t("pipelines")}: ${t(`pipelineStatuses.${status}`)}`}
          className={`h-5 rounded-full px-2 py-0.5 text-xs ${gitLabPipelineStatusClass(status)}`}
          onClick={stopPropagation}
          variant="outline"
        >
          {t(`pipelineStatuses.${status}`)}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
        onClick={stopPropagation}
      >
        <DropdownMenuLabel>{t("pipelines")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {error && (
          <p
            className="px-2 py-1.5 text-xs break-words text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}
        {message && (
          <p
            className="px-2 py-1.5 text-xs break-words text-muted-foreground"
            role="status"
          >
            {message}
          </p>
        )}
        <div className="space-y-1 p-1">
          {pipelines.map((pipeline) => (
            <div
              className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted"
              key={pipeline.id}
            >
              <div className="min-w-0 flex-1">
                <DropdownMenuItem asChild className="gap-1 p-0 font-medium">
                  <a
                    className="hover:underline"
                    href={pipeline.webUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <span className="truncate">
                      #{pipeline.iid ?? pipeline.id} · {pipeline.ref}
                    </span>
                  </a>
                </DropdownMenuItem>
                <span className="block text-xs text-muted-foreground">
                  <GitLabPipelineSource source={pipeline.source} /> ·{" "}
                  <GitLabPipelineStatusBadge status={pipeline.status} />
                </span>
              </div>
              <DropdownMenuItem
                aria-busy={retrying === pipeline.id}
                className={buttonVariants({ size: "sm", variant: "outline" })}
                disabled={retrying !== null || !pipeline.canRetry}
                onSelect={(event) => {
                  event.preventDefault();
                  void retry(pipeline);
                }}
              >
                {retrying === pipeline.id ? (
                  <Spinner aria-hidden="true" />
                ) : (
                  <RotateCcw />
                )}
                {retrying === pipeline.id ? tp("retrying") : t("retry")}
              </DropdownMenuItem>
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
