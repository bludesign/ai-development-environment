"use client";

import {
  ChevronDown,
  ChevronRight,
  CircleStop,
  ExternalLink,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { worktreeDetailHref } from "@/components/worktrees/worktree-navigation";
import { useNow } from "@/hooks/use-now";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";
import { isRowActivation } from "@/lib/row-activation";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightBackgroundClasses,
  worktreeHighlightInsetAccentClasses,
} from "@/lib/worktree-highlight";
import type { GitLabJobView, GitLabPipelineView } from "@/services/gitlab";

import { MergeRequestMenu } from "./merge-request-menu";
import {
  canCancelGitLabPipeline,
  canRetryGitLabJob,
  canRetryGitLabPipeline,
  gitLabDuration,
  isActiveGitLabPipeline,
} from "./pipeline-format";
import {
  GitLabPipelineSource,
  GitLabPipelineStatusBadge,
} from "./pipeline-status-badge";

export const GITLAB_PIPELINE_FIELDS =
  "id projectId iid ref branch sha source status webUrl mergeRequests { projectId iid title webUrl sourceBranch } worktreeId worktreeHighlightColor startedAt createdAt updatedAt finishedAt duration queuedDuration";
const JOB_FIELDS =
  "id pipelineId name stage status ref webUrl allowFailure createdAt startedAt finishedAt duration queuedDuration retried";

type TimedItem = Pick<GitLabPipelineView, "status" | "startedAt" | "duration">;

function ActiveDuration({ item }: { item: TimedItem }) {
  const now = useNow(null);
  return <>{gitLabDuration(item, now ?? Date.parse(item.startedAt ?? ""))}</>;
}

function Duration({ item }: { item: TimedItem }) {
  return isActiveGitLabPipeline(item.status) && item.startedAt ? (
    <ActiveDuration item={item} />
  ) : (
    <>{gitLabDuration(item)}</>
  );
}

function secondsDuration(seconds: number | null) {
  return gitLabDuration({
    status: "SUCCESS",
    startedAt: null,
    duration: seconds,
  });
}

export function GitLabPipelinesTable({
  pipelines,
  onChanged,
  showMergeRequests = true,
  pollIntervalSeconds = 60,
}: {
  pipelines: GitLabPipelineView[];
  onChanged?: () => Promise<void>;
  showMergeRequests?: boolean;
  pollIntervalSeconds?: number;
}) {
  const t = useTranslations("gitlabPages");
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-10">
            <span className="sr-only">{t("expand")}</span>
          </TableHead>
          <TableHead>{t("pipeline")}</TableHead>
          <TableHead>{t("branch")}</TableHead>
          <TableHead>{t("source")}</TableHead>
          <TableHead>{t("status")}</TableHead>
          {showMergeRequests && <TableHead>{t("mergeRequest")}</TableHead>}
          <TableHead>{t("started")}</TableHead>
          <TableHead className="text-right">{t("actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pipelines.length === 0 && (
          <TableRow>
            <TableCell
              colSpan={showMergeRequests ? 8 : 7}
              className="py-8 text-center text-muted-foreground"
            >
              {t("emptyPipelines")}
            </TableCell>
          </TableRow>
        )}
        {pipelines.map((pipeline) => (
          <PipelineRow
            key={`${pipeline.projectId}:${pipeline.id}`}
            pipeline={pipeline}
            onChanged={onChanged}
            showMergeRequests={showMergeRequests}
            pollIntervalSeconds={pollIntervalSeconds}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function PipelineRow({
  pipeline: seed,
  onChanged,
  showMergeRequests,
  pollIntervalSeconds,
}: {
  pipeline: GitLabPipelineView;
  onChanged?: () => Promise<void>;
  showMergeRequests: boolean;
  pollIntervalSeconds: number;
}) {
  const t = useTranslations("gitlabPages");
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<GitLabPipelineView | null>(null);
  const [jobs, setJobs] = useState<GitLabJobView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    id: string;
    jobName?: string;
  } | null>(null);
  const busy = pendingAction !== null;
  const actionHelpId = useId();
  const actionInFlight = useRef(false);
  const mounted = useRef(true);
  const onChangedRef = useRef(onChanged);
  const pipeline =
    detail &&
    (!seed.updatedAt ||
      !detail.updatedAt ||
      Date.parse(detail.updatedAt) >= Date.parse(seed.updatedAt))
      ? detail
      : { ...detail, ...seed };
  // Summary responses omit timing, so keep hydrated timings until a newer detail arrives.
  const displayed = detail
    ? {
        ...pipeline,
        startedAt: detail.startedAt,
        finishedAt: detail.finishedAt,
        duration: detail.duration,
        queuedDuration: detail.queuedDuration,
      }
    : seed;
  const hasLoaded = useRef(false);
  const previousSeed = useRef(`${seed.status}:${seed.updatedAt}`);
  const refreshRef = useRef<ReturnType<typeof createRefreshCoalescer> | null>(
    null,
  );

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    mounted.current = true;
    const refresh = createRefreshCoalescer(async (signal) => {
      setLoading(true);
      try {
        const data = await controlPlaneRequest<{
          gitlabPipeline: GitLabPipelineView;
          gitlabPipelineJobs: GitLabJobView[];
        }>(
          `query GitLabPipelineDetails($projectId: ID!, $pipelineId: ID!) {
            gitlabPipeline(projectId: $projectId, pipelineId: $pipelineId) { ${GITLAB_PIPELINE_FIELDS} }
            gitlabPipelineJobs(projectId: $projectId, pipelineId: $pipelineId) { ${JOB_FIELDS} }
          }`,
          { projectId: seed.projectId, pipelineId: seed.id },
          { signal },
        );
        if (signal.aborted) return;
        setDetail(data.gitlabPipeline);
        setJobs(data.gitlabPipelineJobs);
        hasLoaded.current = true;
        setError(null);
      } catch (value) {
        if (!signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
    refreshRef.current = refresh;
    return () => {
      mounted.current = false;
      refresh.dispose();
      refreshRef.current = null;
    };
  }, [seed.id, seed.projectId]);

  const reload = useCallback(() => {
    void refreshRef.current?.refresh();
  }, []);

  useEffect(() => {
    const revision = `${seed.status}:${seed.updatedAt}`;
    if (previousSeed.current === revision) return;
    previousSeed.current = revision;
    if (expanded && hasLoaded.current && document.visibilityState !== "hidden")
      reload();
  }, [expanded, reload, seed.status, seed.updatedAt]);

  useEffect(() => {
    if (!expanded) return;
    const visibleRefresh = () => {
      if (document.visibilityState !== "hidden") reload();
    };
    const initial = window.setTimeout(() => {
      if (!hasLoaded.current) visibleRefresh();
    }, 0);
    const off = controlPlaneSubscriptions().subscribe<{
      gitlabPipelineStatusChanged: { id: string; projectId: string };
    }>(
      {
        query:
          "subscription GitLabPipelineDetailsChanged { gitlabPipelineStatusChanged { id projectId } }",
      },
      {
        next: ({ data }) => {
          const change = data?.gitlabPipelineStatusChanged;
          if (change?.id === seed.id && change.projectId === seed.projectId)
            visibleRefresh();
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const recover = onControlPlaneRecovery(visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      window.clearTimeout(initial);
      off();
      recover();
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [expanded, reload, seed.id, seed.projectId]);

  const active =
    isActiveGitLabPipeline(displayed.status) ||
    jobs?.some((job) => !job.retried && isActiveGitLabPipeline(job.status));
  useEffect(() => {
    if (!expanded || !active) return;
    const timer = window.setInterval(
      () => {
        if (document.visibilityState !== "hidden")
          void refreshRef.current?.refreshIfIdle();
      },
      Math.max(30, pollIntervalSeconds) * 1_000,
    );
    return () => window.clearInterval(timer);
  }, [active, expanded, pollIntervalSeconds]);

  const action = async (
    operation: "retry" | "cancel" | "job",
    job?: GitLabJobView,
  ) => {
    if (actionInFlight.current) return;
    if (operation === "retry" && !canRetryGitLabPipeline(displayed.status))
      return;
    if (operation === "cancel" && !canCancelGitLabPipeline(displayed.status))
      return;
    if (
      operation === "job" &&
      (!job || job.retried || !canRetryGitLabJob(job.status))
    )
      return;
    actionInFlight.current = true;
    setPendingAction({
      id: job ? `job:${job.id}` : operation,
      jobName: job?.name,
    });
    setActionError(null);
    try {
      if (job) {
        await controlPlaneRequest(
          "mutation RetryGitLabJob($projectId: ID!, $jobId: ID!) { retryGitLabJob(projectId: $projectId, jobId: $jobId) { id } }",
          { projectId: seed.projectId, jobId: job.id },
        );
      } else {
        const mutation =
          operation === "retry"
            ? "retryGitLabPipeline"
            : "cancelGitLabPipeline";
        await controlPlaneRequest(
          `mutation GitLabPipelineAction($projectId: ID!, $pipelineId: ID!) { ${mutation}(projectId: $projectId, pipelineId: $pipelineId) { id } }`,
          { projectId: seed.projectId, pipelineId: seed.id },
        );
      }
      if (!mounted.current) return;
      await Promise.all([
        refreshRef.current?.refresh(),
        onChangedRef.current?.(),
      ]);
    } catch (value) {
      if (mounted.current)
        setActionError(value instanceof Error ? value.message : String(value));
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setPendingAction(null);
    }
  };

  const highlight = seed.worktreeHighlightColor;
  const label = `#${seed.iid ?? seed.id} · ${seed.branch || seed.ref}`;
  const progress = pendingAction
    ? pendingAction.id === "retry"
      ? t("retryingPipeline")
      : pendingAction.id === "cancel"
        ? t("cancelingPipeline")
        : t("retryingJob", { job: pendingAction.jobName ?? "" })
    : null;
  const retryUnavailable = busy
    ? t("pipelineActionPending")
    : !canRetryGitLabPipeline(displayed.status)
      ? t("pipelineRetryUnavailable")
      : null;
  const cancelUnavailable = busy
    ? t("pipelineActionPending")
    : !canCancelGitLabPipeline(displayed.status)
      ? t("pipelineCancelUnavailable")
      : null;
  return (
    <Fragment>
      <TableRow
        className={cn(
          "cursor-pointer",
          highlight && worktreeHighlightBackgroundClasses[highlight],
        )}
        onClick={(event) => {
          if (isRowActivation(event)) setExpanded((value) => !value);
        }}
      >
        <TableCell
          className={cn(
            "pr-0",
            highlight && worktreeHighlightInsetAccentClasses[highlight],
          )}
        >
          <Button
            aria-expanded={expanded}
            aria-label={t(expanded ? "hideJobs" : "showJobs", {
              pipeline: label,
            })}
            onClick={() => setExpanded((value) => !value)}
            size="icon-sm"
            variant="ghost"
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
        </TableCell>
        <TableCell className="min-w-56 whitespace-normal">
          <a
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            href={seed.webUrl}
            rel="noreferrer"
            target="_blank"
          >
            {label}
            <ExternalLink className="size-3.5 shrink-0" />
          </a>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {seed.sha.slice(0, 8)}
          </p>
        </TableCell>
        <TableCell className="min-w-40 whitespace-normal">
          {seed.worktreeId ? (
            <Link
              className="font-mono text-xs text-primary hover:underline"
              href={worktreeDetailHref(seed.worktreeId)}
            >
              {seed.branch}
            </Link>
          ) : (
            <span className="font-mono text-xs">{seed.branch || seed.ref}</span>
          )}
        </TableCell>
        <TableCell>
          <GitLabPipelineSource source={seed.source} />
        </TableCell>
        <TableCell>
          <GitLabPipelineStatusBadge status={displayed.status} />
        </TableCell>
        {showMergeRequests && (
          <TableCell className="min-w-48 whitespace-normal">
            {!seed.mergeRequests?.length ? (
              "—"
            ) : (
              <div className="flex flex-col gap-1">
                {seed.mergeRequests.map((mr) => (
                  <div
                    className="flex items-center gap-2"
                    key={`${mr.projectId}:${mr.iid}`}
                  >
                    <MergeRequestMenu
                      label={`MR !${mr.iid}`}
                      mergeRequest={mr}
                    />
                    <span className="text-sm font-medium">{mr.title}</span>
                  </div>
                ))}
              </div>
            )}
          </TableCell>
        )}
        <TableCell className="text-muted-foreground">
          <div className="flex flex-col gap-0.5">
            <DateTime kind="time" relativeToday value={displayed.startedAt} />
            <span className="text-xs">
              {t("duration", { duration: "" })}
              <Duration item={displayed} />
            </span>
          </div>
        </TableCell>
        <TableCell className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`${t("actions")}: ${label}`}
                disabled={busy}
                size="icon-sm"
                variant="outline"
              >
                {busy ? <Spinner aria-hidden="true" /> : <MoreHorizontal />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <a href={seed.webUrl} rel="noreferrer" target="_blank">
                  <ExternalLink />
                  {t("openGitLab")}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem
                aria-label={t("retry")}
                aria-describedby={
                  retryUnavailable ? `${actionHelpId}-retry` : undefined
                }
                title={retryUnavailable ?? undefined}
                disabled={Boolean(retryUnavailable)}
                onSelect={() => void action("retry")}
              >
                <RotateCcw />
                <span>
                  {t("retry")}
                  {retryUnavailable && (
                    <span
                      id={`${actionHelpId}-retry`}
                      className="mt-0.5 block max-w-64 text-xs whitespace-normal text-muted-foreground"
                    >
                      {retryUnavailable}
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                aria-label={t("cancel")}
                aria-describedby={
                  cancelUnavailable ? `${actionHelpId}-cancel` : undefined
                }
                title={cancelUnavailable ?? undefined}
                disabled={Boolean(cancelUnavailable)}
                onSelect={() => void action("cancel")}
              >
                <CircleStop />
                <span>
                  {t("cancel")}
                  {cancelUnavailable && (
                    <span
                      id={`${actionHelpId}-cancel`}
                      className="mt-0.5 block max-w-64 text-xs whitespace-normal text-muted-foreground"
                    >
                      {cancelUnavailable}
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {progress && (
            <p
              role="status"
              className="mt-1 max-w-48 text-xs whitespace-normal text-muted-foreground"
            >
              {progress}
            </p>
          )}
        </TableCell>
      </TableRow>
      {(expanded || actionError) && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell
            className="whitespace-normal p-4"
            colSpan={showMergeRequests ? 8 : 7}
          >
            {actionError && (
              <Alert className="mb-3" variant="destructive">
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            )}
            {expanded && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
                  <span>
                    {t("finished")}{" "}
                    <DateTime
                      kind="time"
                      relativeToday
                      value={displayed.finishedAt}
                    />
                  </span>
                  <span>
                    {t("queued")} {secondsDuration(displayed.queuedDuration)}
                  </span>
                  <Button
                    className="ml-auto"
                    aria-label={t("refreshJobs")}
                    disabled={loading}
                    onClick={reload}
                    size="sm"
                    variant="ghost"
                  >
                    {loading ? <Spinner /> : <RefreshCw />}
                    {t(loading ? "refreshing" : "refreshJobs")}
                  </Button>
                </div>
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                {loading && !jobs ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner />
                    {t("loadingJobs")}
                  </div>
                ) : (
                  jobs && (
                    <GitLabPipelineJobs
                      jobs={jobs}
                      busy={busy}
                      pendingJobId={
                        pendingAction?.id.startsWith("job:")
                          ? pendingAction.id.slice(4)
                          : null
                      }
                      onRetry={(job) => void action("job", job)}
                    />
                  )
                )}
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

export function GitLabPipelineJobs({
  jobs,
  busy,
  pendingJobId,
  onRetry,
}: {
  jobs: GitLabJobView[];
  busy: boolean;
  pendingJobId?: string | null;
  onRetry: (job: GitLabJobView) => void;
}) {
  const t = useTranslations("gitlabPages");
  const [showHistory, setShowHistory] = useState(false);
  const current = jobs.filter((job) => !job.retried);
  const stages = [...new Set(current.map((job) => job.stage))].sort((a, b) =>
    a.localeCompare(b),
  );
  const history = jobs.filter((job) => job.retried);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {t("jobCount", { count: current.length })}
        </p>
        {history.length > 0 && (
          <Button
            aria-expanded={showHistory}
            onClick={() => setShowHistory((value) => !value)}
            size="sm"
            variant="ghost"
          >
            {t(showHistory ? "hideRetryHistory" : "showRetryHistory")}
          </Button>
        )}
      </div>
      {current.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("noJobs")}</p>
      )}
      {stages.map((stage) => (
        <section key={stage} className="rounded-md border bg-background">
          <h4 className="border-b px-3 py-2 text-sm font-medium">
            {t("stage")} · {stage}
          </h4>
          <div className="divide-y">
            {current
              .filter((job) => job.stage === stage)
              .map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  busy={busy}
                  pending={pendingJobId === job.id}
                  onRetry={onRetry}
                />
              ))}
          </div>
        </section>
      ))}
      {showHistory && (
        <section className="rounded-md border bg-background">
          <h4 className="border-b px-3 py-2 text-sm font-medium">
            {t("retryHistory")}
          </h4>
          <div className="divide-y">
            {history.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                busy={busy}
                pending={pendingJobId === job.id}
                onRetry={onRetry}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function JobRow({
  job,
  busy,
  pending,
  onRetry,
}: {
  job: GitLabJobView;
  busy: boolean;
  pending: boolean;
  onRetry: (job: GitLabJobView) => void;
}) {
  const t = useTranslations("gitlabPages");
  const helpId = useId();
  const unavailable = pending
    ? t("retryingJob", { job: job.name })
    : busy
      ? t("pipelineActionPending")
      : job.retried
        ? t("jobRetryHistoryUnavailable")
        : !canRetryGitLabJob(job.status)
          ? t("jobRetryUnavailable")
          : null;
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2">
      <a
        className="min-w-32 flex-1 text-sm font-medium text-primary hover:underline"
        href={job.webUrl}
        rel="noreferrer"
        target="_blank"
      >
        {job.name}
        <ExternalLink className="ml-1 inline size-3" />
      </a>
      {job.allowFailure && (
        <Badge variant="outline">{t("allowedFailure")}</Badge>
      )}
      {job.retried && <Badge variant="secondary">{t("retriedJob")}</Badge>}
      <GitLabPipelineStatusBadge status={job.status} />
      <div className="text-right text-xs text-muted-foreground">
        <div>
          {t("started")}{" "}
          <DateTime kind="time" relativeToday value={job.startedAt} />
        </div>
        <div>
          {t("duration", { duration: "" })}
          <Duration item={job} /> · {t("queued")}{" "}
          {secondsDuration(job.queuedDuration)}
        </div>
      </div>
      <Button
        aria-label={t("retryJob", { job: job.name })}
        aria-describedby={unavailable ? helpId : undefined}
        title={unavailable ?? undefined}
        disabled={Boolean(unavailable)}
        onClick={() => onRetry(job)}
        size="icon-sm"
        variant="ghost"
      >
        {pending ? <Spinner aria-hidden="true" /> : <RotateCcw />}
      </Button>
      {unavailable && (
        <span className="sr-only" id={helpId}>
          {unavailable}
        </span>
      )}
    </div>
  );
}
