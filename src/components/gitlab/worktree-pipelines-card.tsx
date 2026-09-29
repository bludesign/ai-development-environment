"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import type { GitLabPipelineView } from "@/services/gitlab";

import { GitLabPipelinesTable } from "./pipelines-table";

export function GitLabWorktreePipelinesCard({
  pipelines,
  onChanged,
}: {
  pipelines: GitLabPipelineView[];
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("gitlabPages");
  if (!pipelines.length) return null;
  return (
    <Card className="min-w-0 gap-0 py-0">
      <CardHeader className="flex grid-cols-none flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>{t("pipelinesTitle")}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t(
              pipelines.length === 1 ? "pipelineCount" : "pipelineCountPlural",
              { count: pipelines.length },
            )}
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link
            href={`/gitlab/pipelines?project=${encodeURIComponent(pipelines[0].projectId)}`}
          >
            {t("allPipelines")}
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="px-0">
        <GitLabPipelinesTable
          pipelines={pipelines}
          onChanged={onChanged}
          showMergeRequests={false}
        />
      </CardContent>
    </Card>
  );
}
