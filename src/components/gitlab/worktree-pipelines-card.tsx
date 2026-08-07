"use client";

import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { isRowActivation } from "@/lib/row-activation";
import type { GitLabJobView, GitLabPipelineView } from "@/services/gitlab";

import {
  canRetryGitLabJob,
  gitLabDuration,
  gitLabPipelineStatusClass,
} from "./pipeline-format";

type GitLabJobState = {
  loading: boolean;
  error: string | null;
  jobs: GitLabJobView[] | null;
};

export function GitLabWorktreePipelinesCard({
  pipelines,
  onChanged,
}: {
  pipelines: GitLabPipelineView[];
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("gitlabPages");
  const [expandedPipelines, setExpandedPipelines] = useState<Set<string>>(
    () => new Set(),
  );
  const [jobStates, setJobStates] = useState<Record<string, GitLabJobState>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  if (!pipelines.length) return null;

  const loadJobs = async (pipeline: GitLabPipelineView) => {
    setJobStates((current) => ({
      ...current,
      [pipeline.id]: {
        loading: true,
        error: null,
        jobs: current[pipeline.id]?.jobs ?? null,
      },
    }));
    try {
      const data = await controlPlaneRequest<{
        gitlabPipelineJobs: GitLabJobView[];
      }>(
        `query WorktreeGitLabPipelineJobs($projectId: ID!, $pipelineId: ID!) {
          gitlabPipelineJobs(projectId: $projectId, pipelineId: $pipelineId) {
            id pipelineId name stage status ref webUrl allowFailure createdAt startedAt
            finishedAt duration queuedDuration retried
          }
        }`,
        { projectId: pipeline.projectId, pipelineId: pipeline.id },
      );
      setJobStates((current) => ({
        ...current,
        [pipeline.id]: {
          loading: false,
          error: null,
          jobs: data.gitlabPipelineJobs,
        },
      }));
    } catch (value) {
      setJobStates((current) => ({
        ...current,
        [pipeline.id]: {
          loading: false,
          error: value instanceof Error ? value.message : String(value),
          jobs: current[pipeline.id]?.jobs ?? null,
        },
      }));
    }
  };

  const togglePipeline = (pipeline: GitLabPipelineView) => {
    const expanding = !expandedPipelines.has(pipeline.id);
    setExpandedPipelines((current) => {
      const next = new Set(current);
      if (next.has(pipeline.id)) next.delete(pipeline.id);
      else next.add(pipeline.id);
      return next;
    });
    if (expanding && !jobStates[pipeline.id]) void loadJobs(pipeline);
  };

  const pipelineMutation = async (
    operation: "retry" | "cancel",
    pipeline: GitLabPipelineView,
  ) => {
    setBusy(true);
    setActionError(null);
    try {
      const mutation =
        operation === "retry" ? "retryGitLabPipeline" : "cancelGitLabPipeline";
      await controlPlaneRequest(
        `mutation WorktreeGitLabPipelineAction($projectId: ID!, $pipelineId: ID!) {
          ${mutation}(projectId: $projectId, pipelineId: $pipelineId) { id }
        }`,
        { projectId: pipeline.projectId, pipelineId: pipeline.id },
      );
      await onChanged();
    } catch (value) {
      setActionError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const retryJob = async (pipeline: GitLabPipelineView, jobId: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await controlPlaneRequest(
        `mutation WorktreeRetryGitLabJob($projectId: ID!, $jobId: ID!) {
          retryGitLabJob(projectId: $projectId, jobId: $jobId) { id }
        }`,
        { projectId: pipeline.projectId, jobId },
      );
      await Promise.all([loadJobs(pipeline), onChanged()]);
    } catch (value) {
      setActionError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

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
          <Link href="/gitlab/pipelines">{t("allPipelines")}</Link>
        </Button>
      </CardHeader>
      <CardContent className="px-0">
        {actionError ? (
          <Alert className="m-4" variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10">
                <span className="sr-only">{t("expand")}</span>
              </TableHead>
              <TableHead>{t("pipeline")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead>{t("source")}</TableHead>
              <TableHead className="text-right">{t("started")}</TableHead>
              <TableHead className="text-right">{t("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pipelines.map((pipeline) => {
              const expanded = expandedPipelines.has(pipeline.id);
              return (
                <Fragment key={pipeline.id}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={(event) => {
                      if (isRowActivation(event)) togglePipeline(pipeline);
                    }}
                  >
                    <TableCell className="pr-0">
                      <Button
                        aria-expanded={expanded}
                        aria-label={t(expanded ? "hideJobs" : "showJobs", {
                          pipeline: `#${pipeline.iid ?? pipeline.id} · ${pipeline.ref}`,
                        })}
                        onClick={() => togglePipeline(pipeline)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        {expanded ? <ChevronDown /> : <ChevronRight />}
                      </Button>
                    </TableCell>
                    <TableCell className="min-w-64 whitespace-normal">
                      <a
                        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        href={pipeline.webUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        #{pipeline.iid ?? pipeline.id} · {pipeline.ref}
                        <ExternalLink className="size-3.5 shrink-0" />
                      </a>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {pipeline.sha.slice(0, 8)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={gitLabPipelineStatusClass(pipeline.status)}
                      >
                        {pipeline.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{pipeline.source}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      <DateTime
                        kind="time"
                        relativeToday
                        value={pipeline.startedAt ?? pipeline.createdAt}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          disabled={
                            busy ||
                            !["FAILED", "CANCELED"].includes(pipeline.status)
                          }
                          onClick={() =>
                            void pipelineMutation("retry", pipeline)
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <RotateCcw />
                          {t("retry")}
                        </Button>
                        <Button
                          disabled={
                            busy ||
                            ![
                              "CREATED",
                              "PENDING",
                              "RUNNING",
                              "PREPARING",
                              "WAITING_FOR_RESOURCE",
                            ].includes(pipeline.status)
                          }
                          onClick={() =>
                            void pipelineMutation("cancel", pipeline)
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <Square />
                          {t("cancel")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {expanded ? (
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell className="p-0" colSpan={6}>
                        <GitLabPipelineJobs
                          busy={busy}
                          onReload={() => void loadJobs(pipeline)}
                          onRetry={(jobId) => void retryJob(pipeline, jobId)}
                          state={jobStates[pipeline.id]}
                        />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function GitLabPipelineJobs({
  state,
  busy,
  onReload,
  onRetry,
}: {
  state: GitLabJobState | undefined;
  busy: boolean;
  onReload: () => void;
  onRetry: (jobId: string) => void;
}) {
  const t = useTranslations("gitlabPages");

  return (
    <div className="border-l-2 border-muted-foreground/20 px-4 py-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {state?.jobs ? t("jobCount", { count: state.jobs.length }) : t("jobs")}
      </p>
      {state?.loading && !state.jobs ? (
        <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
          <Spinner /> {t("loadingJobs")}
        </div>
      ) : state?.error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{state.error}</span>
            <Button
              onClick={onReload}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw /> {t("retryLoad")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : state?.jobs?.length === 0 ? (
        <p className="px-2 py-3 text-sm text-muted-foreground">{t("noJobs")}</p>
      ) : state?.jobs ? (
        <div className="divide-y">
          {state.jobs.map((job) => (
            <div className="flex items-center gap-2 px-2 py-1.5" key={job.id}>
              <a
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={job.webUrl}
                rel="noreferrer"
                target="_blank"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {job.stage} / {job.name}
                </span>
                <Badge className={gitLabPipelineStatusClass(job.status)}>
                  {job.status}
                </Badge>
              </a>
              <div className="min-w-32 text-right text-xs text-muted-foreground">
                <div>
                  {t("started")}{" "}
                  <DateTime kind="time" relativeToday value={job.startedAt} />
                </div>
                <div>{t("duration", { duration: gitLabDuration(job) })}</div>
              </div>
              <Button
                aria-label={t("retryJob", { job: job.name })}
                disabled={busy || !canRetryGitLabJob(job.status)}
                onClick={() => onRetry(job.id)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <RotateCcw />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
