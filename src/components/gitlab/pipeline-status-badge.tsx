"use client";

import {
  CheckCircle2,
  CircleDashed,
  CirclePause,
  CircleX,
  Clock3,
  LoaderCircle,
  SkipForward,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { GitLabPipelineStatus } from "@/services/gitlab";

import {
  gitLabPipelineSources,
  gitLabPipelineStatusClass,
  isActiveGitLabPipeline,
} from "./pipeline-format";

export function GitLabPipelineStatusBadge({
  status,
}: {
  status: GitLabPipelineStatus;
}) {
  const t = useTranslations("gitlabPages");
  const Icon =
    status === "SUCCESS"
      ? CheckCircle2
      : status === "FAILED" || status === "CANCELED"
        ? CircleX
        : status === "RUNNING" || status === "CANCELING"
          ? LoaderCircle
          : status === "MANUAL"
            ? CirclePause
            : status === "SKIPPED"
              ? SkipForward
              : isActiveGitLabPipeline(status) || status === "SCHEDULED"
                ? Clock3
                : CircleDashed;
  return (
    <Badge className={gitLabPipelineStatusClass(status)}>
      <Icon aria-hidden="true" className="size-3" />
      {t(`pipelineStatuses.${status}`)}
    </Badge>
  );
}

export function GitLabPipelineSource({ source }: { source: string }) {
  const t = useTranslations("gitlabPages");
  const key =
    gitLabPipelineSources.find((value) => value === source) ?? "unknown";
  return <span>{t(`pipelineSources.${key}`)}</span>;
}
