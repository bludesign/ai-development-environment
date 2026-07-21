"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useEffect, useMemo, useState } from "react";

import { AutoRetryDialog } from "@/components/github/auto-retry-dialog";
import {
  PipelineMenu,
  RetryPipelineButton,
  pipelineStateClass,
} from "@/components/github/pipeline-menu";
import { WorkflowAttemptSelect } from "@/components/github/workflow-attempt-select";
import { WorkflowJob } from "@/components/github/workflow-job";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitHubActionsWorkflowRunView,
  GitHubPipelineStatus,
  GitHubPipelineView,
  GitHubWorkflowJobView,
  GitHubWorkflowRunAttemptView,
} from "@/services/github/types";

const FAILURE_STATES = new Set([
  "CANCELLED",
  "ERROR",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const PENDING_STATES = new Set([
  "ACTION_REQUIRED",
  "EXPECTED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
]);

function aggregateStatus(
  runs: GitHubActionsWorkflowRunView[],
): GitHubPipelineStatus {
  if (runs.some((run) => FAILURE_STATES.has(run.status))) return "FAILURE";
  if (runs.some((run) => PENDING_STATES.has(run.status))) return "PENDING";
  if (runs.length && runs.every((run) => run.status === "SUCCESS")) {
    return "SUCCESS";
  }
  return "NONE";
}

function pipelineView(
  run: GitHubActionsWorkflowRunView,
  jobs: GitHubWorkflowJobView[],
): GitHubPipelineView {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    url: run.url,
    checkSuiteId: run.checkSuiteId,
    canRetry: run.canRetry,
    retryUnavailableReason: run.retryUnavailableReason,
    jobs,
    workflowRunId: run.id,
    workflowId: run.workflowId,
    runNumber: run.runNumber,
    runAttempt: run.runAttempt,
  };
}

export function WorktreePipelinesCard({
  runs,
  error,
  worktreeId,
  branch,
  onError,
}: {
  runs: GitHubActionsWorkflowRunView[];
  error: string | null;
  worktreeId: string;
  branch: string | null;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("pullRequestDetail");
  const tp = useTranslations("pullRequests");
  const [jobs, setJobs] = useState<Record<string, GitHubWorkflowJobView[]>>({});
  const [attempts, setAttempts] = useState<
    Record<string, GitHubWorkflowRunAttemptView | null>
  >({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      runs.map(async (run) => {
        try {
          const data = await controlPlaneRequest<{
            githubActionsWorkflowJobs: GitHubWorkflowJobView[];
          }>(
            `query WorktreePipelineJobs($repositoryId: ID!, $workflowRunId: ID!) {
              githubActionsWorkflowJobs(
                codebaseRepositoryId: $repositoryId
                workflowRunId: $workflowRunId
              ) { id name status url canRetry retryUnavailableReason runAttempt steps { number name status } }
            }`,
            {
              repositoryId: run.codebaseRepositoryId,
              workflowRunId: run.id,
            },
          );
          return [run.id, data.githubActionsWorkflowJobs] as const;
        } catch {
          return [run.id, []] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setJobs(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [runs]);

  const pipelines = useMemo(
    () => runs.map((run) => pipelineView(run, jobs[run.id] ?? [])),
    [jobs, runs],
  );

  const jobRetried = (runId: string, jobId: string) => {
    setJobs((current) => ({
      ...current,
      [runId]: (current[runId] ?? []).map((job) =>
        job.id === jobId
          ? {
              ...job,
              status: "QUEUED",
              canRetry: false,
              retryUnavailableReason: "NOT_COMPLETED",
              steps: [],
            }
          : {
              ...job,
              canRetry: false,
              retryUnavailableReason: "NOT_COMPLETED",
            },
      ),
    }));
  };

  if (!runs.length && !error) return null;

  return (
    <Card className="min-w-0 gap-0 py-0">
      <CardHeader className="flex grid-cols-none flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>{t("pipelines")}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("pipelineCount", { count: runs.length })}
          </p>
        </div>
        {runs.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <AutoRetryDialog
              allowFuture={Boolean(branch)}
              branch={branch}
              codebaseRepositoryId={runs[0].codebaseRepositoryId}
              currentRuns={runs.map((run) => ({
                id: run.id,
                workflowId: run.workflowId,
                name: run.name,
                jobs: jobs[run.id],
              }))}
              repositoryGithubId={runs[0].repositoryGithubId}
              worktreeId={worktreeId}
            />
            <PipelineMenu
              pipelineStatus={aggregateStatus(runs)}
              pipelines={pipelines}
              repositoryId={runs[0].repositoryGithubId}
            />
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="px-0">
        {error ? (
          <Alert className="m-4" variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {runs.length ? (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t("pipelineName")}</TableHead>
                <TableHead>{t("pipelineStatus")}</TableHead>
                <TableHead className="text-right">
                  {t("pipelineDetails")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const historical = attempts[run.id] ?? null;
                const displayedJobs = historical?.jobs ?? jobs[run.id] ?? [];
                const pipeline = pipelineView(run, jobs[run.id] ?? []);
                return (
                  <Fragment key={run.id}>
                    <TableRow>
                      <TableCell className="font-medium">
                        {run.name}
                        <div className="mt-2">
                          <WorkflowAttemptSelect
                            latestAttempt={run.runAttempt}
                            onAttemptChange={(attempt) =>
                              setAttempts((current) => ({
                                ...current,
                                [run.id]: attempt,
                              }))
                            }
                            repositoryId={run.codebaseRepositoryId}
                            workflowRunId={run.id}
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={pipelineStateClass(
                            historical?.status ?? run.status,
                          )}
                        >
                          {tp(
                            `pipelineStates.${historical?.status ?? run.status}`,
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button asChild size="sm" variant="outline">
                            <a
                              href={historical?.url ?? run.url}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {t("viewPipeline")}
                              <ExternalLink />
                            </a>
                          </Button>
                          {!historical ? (
                            <RetryPipelineButton
                              onError={onError}
                              pipeline={pipeline}
                              repositoryId={run.repositoryGithubId}
                            />
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell className="p-0" colSpan={3}>
                        <div className="border-l-2 border-muted-foreground/20 px-4 py-1">
                          <p className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {t("jobCount", { count: displayedJobs.length })}
                          </p>
                          {displayedJobs.length === 0 ? (
                            <p className="px-3 pb-3 text-sm text-muted-foreground">
                              {t("noJobs")}
                            </p>
                          ) : (
                            <div className="divide-y">
                              {displayedJobs.map((job) => (
                                <WorkflowJob
                                  checkSuiteId={run.checkSuiteId}
                                  job={job}
                                  key={job.id}
                                  onError={onError}
                                  onRetried={() => jobRetried(run.id, job.id)}
                                  repositoryId={run.repositoryGithubId}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}
