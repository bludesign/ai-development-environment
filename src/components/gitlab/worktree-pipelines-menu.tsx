"use client";

import { ChevronDown, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import type { MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { GitLabPipelineView } from "@/services/gitlab";

import {
  aggregateGitLabPipelineStatus,
  gitLabPipelineStatusClass,
} from "./pipeline-format";

export function GitLabWorktreePipelinesMenu({
  pipelines,
}: {
  pipelines: GitLabPipelineView[];
}) {
  const t = useTranslations("gitlabPages");
  if (!pipelines.length) return null;

  const status = aggregateGitLabPipelineStatus(
    pipelines.map((pipeline) => pipeline.status),
  );
  const stopPropagation = (event: MouseEvent) => event.stopPropagation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`${t("pipelines")}: ${status}`}
          className={`h-5 rounded-full px-2 py-0.5 text-xs ${gitLabPipelineStatusClass(status)}`}
          onClick={stopPropagation}
          variant="outline"
        >
          {status}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-80"
        onClick={stopPropagation}
      >
        <DropdownMenuLabel>{t("pipelines")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {pipelines.map((pipeline) => (
          <DropdownMenuItem asChild key={pipeline.id}>
            <a href={pipeline.webUrl} rel="noreferrer" target="_blank">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  #{pipeline.iid ?? pipeline.id} · {pipeline.ref}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {pipeline.source} · {pipeline.status}
                </span>
              </span>
              <ExternalLink className="size-3.5 shrink-0" />
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
