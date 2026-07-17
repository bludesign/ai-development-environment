"use client";

import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  PlayCircle,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Fragment, MouseEvent, useCallback, useEffect, useState } from "react";

import {
  RetryPipelineButton,
  pipelineStateClass,
} from "@/components/github/pipeline-menu";
import { pullRequestDetailHref } from "@/components/github/pull-request-links";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "@/components/ui/searchable-select";
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
import type {
  GitHubActionsRepositoryErrorView,
  GitHubActionsRepositoryView,
  GitHubActionsWorkflowRunPage,
  GitHubActionsWorkflowRunView,
  GitHubPipelineView,
  GitHubSettingsView,
  GitHubWorkflowJobView,
} from "@/services/github/types";
import { worktreeDetailHref } from "@/components/worktrees/worktree-navigation";

const ALL_REPOSITORIES = "all";
const RUN_FIELDS =
  "id repositoryGithubId codebaseRepositoryId repositoryNameWithOwner repositoryUrl name displayTitle runNumber runAttempt event status url headBranch headSha checkSuiteId canRetry retryUnavailableReason pullRequests { number url } jiraKey worktreeId createdAt updatedAt";
const REPOSITORY_FIELDS = "id nameWithOwner url";
const JOB_FIELDS =
  "id name status url canRetry retryUnavailableReason steps { number name status }";

type JobState = {
  loading: boolean;
  error: string | null;
  jobs: GitHubWorkflowJobView[] | null;
};

function runKey(run: GitHubActionsWorkflowRunView) {
  return `${run.codebaseRepositoryId}:${run.id}`;
}

function replaceIssueParam(issueKey: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (issueKey) params.set("issue", issueKey);
  else params.delete("issue");
  const query = params.toString();
  window.history.pushState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}`,
  );
}

function relativeAge(value: string, locale: string) {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return formatter.format(seconds, "second");
}

export function ActionsPage() {
  const t = useTranslations("actionsPage");
  const searchParams = useSearchParams();
  const issueKey = searchParams.get("issue");
  const [settings, setSettings] = useState<GitHubSettingsView | null>(null);
  const [configurationLoading, setConfigurationLoading] = useState(true);
  const [runs, setRuns] = useState<GitHubActionsWorkflowRunView[]>([]);
  const [repositories, setRepositories] = useState<
    GitHubActionsRepositoryView[]
  >([]);
  const [repositoryErrors, setRepositoryErrors] = useState<
    GitHubActionsRepositoryErrorView[]
  >([]);
  const [selectedRepositoryId, setSelectedRepositoryId] =
    useState(ALL_REPOSITORIES);
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [jobStates, setJobStates] = useState<Record<string, JobState>>({});

  const loadRuns = useCallback(
    async (
      repositoryId: string,
      options: { append: boolean; cursor?: string | null } = {
        append: false,
      },
    ) => {
      if (options.append) setLoadingMore(true);
      else {
        setLoading(true);
        setRuns([]);
        setRepositoryErrors([]);
        setEndCursor(null);
        setHasNextPage(false);
        setExpandedRuns(new Set());
        setJobStates({});
      }
      try {
        const data = await controlPlaneRequest<{
          githubActionsWorkflowRuns: GitHubActionsWorkflowRunPage;
        }>(
          `query GitHubActionsWorkflowRuns(
            $codebaseRepositoryId: ID
            $first: Int!
            $after: String
          ) {
            githubActionsWorkflowRuns(
              codebaseRepositoryId: $codebaseRepositoryId
              first: $first
              after: $after
            ) {
              items { ${RUN_FIELDS} }
              repositories { ${REPOSITORY_FIELDS} }
              repositoryErrors { codebaseRepositoryId nameWithOwner message }
              hasNextPage
              endCursor
            }
          }`,
          {
            codebaseRepositoryId:
              repositoryId === ALL_REPOSITORIES ? null : repositoryId,
            first: 25,
            after: options.cursor ?? null,
          },
        );
        const page = data.githubActionsWorkflowRuns;
        setRuns((current) =>
          options.append
            ? [
                ...current,
                ...page.items.filter(
                  (item) =>
                    !current.some(
                      (existing) => runKey(existing) === runKey(item),
                    ),
                ),
              ]
            : page.items,
        );
        setRepositories(page.repositories);
        setRepositoryErrors(page.repositoryErrors);
        setEndCursor(page.endCursor);
        setHasNextPage(page.hasNextPage);
        setError(null);
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [],
  );

  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      try {
        const data = await controlPlaneRequest<{
          githubSettings: GitHubSettingsView;
        }>(
          "query GitHubActionsConfiguration { githubSettings { tokenConfigured defaultJiraKeyRegex updatedAt } }",
        );
        setSettings(data.githubSettings);
        setError(null);
        if (data.githubSettings.tokenConfigured) {
          await loadRuns(ALL_REPOSITORIES);
        }
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        setConfigurationLoading(false);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadRuns]);

  const selectRepository = (repositoryId: string) => {
    setSelectedRepositoryId(repositoryId);
    void loadRuns(repositoryId);
  };

  const loadJobs = useCallback(async (run: GitHubActionsWorkflowRunView) => {
    const key = runKey(run);
    setJobStates((current) => ({
      ...current,
      [key]: { loading: true, error: null, jobs: current[key]?.jobs ?? null },
    }));
    try {
      const data = await controlPlaneRequest<{
        githubActionsWorkflowJobs: GitHubWorkflowJobView[];
      }>(
        `query GitHubActionsWorkflowJobs(
            $codebaseRepositoryId: ID!
            $workflowRunId: ID!
          ) {
            githubActionsWorkflowJobs(
              codebaseRepositoryId: $codebaseRepositoryId
              workflowRunId: $workflowRunId
            ) { ${JOB_FIELDS} }
          }`,
        {
          codebaseRepositoryId: run.codebaseRepositoryId,
          workflowRunId: run.id,
        },
      );
      setJobStates((current) => ({
        ...current,
        [key]: {
          loading: false,
          error: null,
          jobs: data.githubActionsWorkflowJobs,
        },
      }));
    } catch (value) {
      setJobStates((current) => ({
        ...current,
        [key]: {
          loading: false,
          error: value instanceof Error ? value.message : String(value),
          jobs: current[key]?.jobs ?? null,
        },
      }));
    }
  }, []);

  const toggleRun = (run: GitHubActionsWorkflowRunView) => {
    const key = runKey(run);
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!expandedRuns.has(key) && !jobStates[key]) void loadJobs(run);
  };

  const runRetried = (run: GitHubActionsWorkflowRunView) => {
    const key = runKey(run);
    setRuns((current) =>
      current.map((item) =>
        runKey(item) === key
          ? {
              ...item,
              status: "QUEUED",
              canRetry: false,
              retryUnavailableReason: "NOT_COMPLETED",
            }
          : item,
      ),
    );
    setJobStates((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setExpandedRuns((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  const jobRetried = (run: GitHubActionsWorkflowRunView, jobId: string) => {
    const key = runKey(run);
    setRuns((current) =>
      current.map((item) =>
        runKey(item) === key
          ? {
              ...item,
              status: "QUEUED",
              canRetry: false,
              retryUnavailableReason: "NOT_COMPLETED",
            }
          : item,
      ),
    );
    setJobStates((current) => {
      const state = current[key];
      if (!state?.jobs) return current;
      return {
        ...current,
        [key]: {
          ...state,
          jobs: state.jobs.map((job) =>
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
        },
      };
    });
  };

  const repositoryOptions: SearchableSelectOption[] = [
    {
      value: ALL_REPOSITORIES,
      label: t("allRepositories"),
      keywords: t("allRepositories"),
    },
    ...repositories.map((repository) => ({
      value: repository.id,
      label: repository.nameWithOwner,
      keywords: repository.nameWithOwner,
    })),
  ];

  return (
    <section className="mx-auto flex w-full max-w-[1800px] flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button
          disabled={!settings?.tokenConfigured || loading}
          onClick={() => void loadRuns(selectedRepositoryId)}
          variant="outline"
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          {t("refresh")}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {configurationLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loadingConfiguration")}
        </div>
      ) : !settings?.tokenConfigured ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlayCircle />
            </EmptyMedia>
            <EmptyTitle>{t("credentialsRequired")}</EmptyTitle>
            <EmptyDescription>
              {t("credentialsRequiredDescription")}
            </EmptyDescription>
          </EmptyHeader>
          <Button asChild className="mt-4">
            <Link href="/settings">{t("openSettings")}</Link>
          </Button>
        </Empty>
      ) : (
        <>
          {repositories.length > 0 && (
            <div className="max-w-lg">
              <SearchableSelect
                ariaLabel={t("repositoryFilter")}
                emptyMessage={t("noRepositoryMatches")}
                onValueChange={selectRepository}
                options={repositoryOptions}
                placeholder={t("repositoryFilter")}
                searchPlaceholder={t("searchRepositories")}
                value={selectedRepositoryId}
              />
            </div>
          )}

          {repositoryErrors.map((repositoryError) => (
            <Alert key={repositoryError.codebaseRepositoryId}>
              <AlertDescription>
                <span className="font-medium">
                  {repositoryError.nameWithOwner}:
                </span>{" "}
                {repositoryError.message}
              </AlertDescription>
            </Alert>
          ))}

          {loading && runs.length === 0 ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Spinner />
              {t("loadingRuns")}
            </div>
          ) : repositories.length === 0 ? (
            <Empty className="border py-12">
              <EmptyHeader>
                <EmptyTitle>{t("noCodebases")}</EmptyTitle>
                <EmptyDescription>
                  {t("noCodebasesDescription")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : runs.length === 0 ? (
            <Empty className="border py-12">
              <EmptyHeader>
                <EmptyTitle>{t("empty")}</EmptyTitle>
                <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ActionsTable
              expandedRuns={expandedRuns}
              jobStates={jobStates}
              onError={setError}
              onJobRetried={jobRetried}
              onLoadJobs={loadJobs}
              onRunRetried={runRetried}
              onToggleRun={toggleRun}
              runs={runs}
            />
          )}

          {hasNextPage && (
            <Button
              className="self-center"
              disabled={loadingMore || !endCursor}
              onClick={() =>
                void loadRuns(selectedRepositoryId, {
                  append: true,
                  cursor: endCursor,
                })
              }
              variant="outline"
            >
              {loadingMore && <Spinner />}
              {loadingMore ? t("loadingMore") : t("loadMore")}
            </Button>
          )}
        </>
      )}

      <JiraTicketDrawer
        issueKey={issueKey}
        onClose={() => replaceIssueParam(null)}
      />
    </section>
  );
}

function ActionsTable({
  runs,
  expandedRuns,
  jobStates,
  onToggleRun,
  onLoadJobs,
  onRunRetried,
  onJobRetried,
  onError,
}: {
  runs: GitHubActionsWorkflowRunView[];
  expandedRuns: Set<string>;
  jobStates: Record<string, JobState>;
  onToggleRun: (run: GitHubActionsWorkflowRunView) => void;
  onLoadJobs: (run: GitHubActionsWorkflowRunView) => void;
  onRunRetried: (run: GitHubActionsWorkflowRunView) => void;
  onJobRetried: (run: GitHubActionsWorkflowRunView, jobId: string) => void;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("actionsPage");
  const tp = useTranslations("pullRequests");
  const locale = useLocale();

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <span className="sr-only">{t("expand")}</span>
            </TableHead>
            <TableHead>{t("repository")}</TableHead>
            <TableHead>{t("workflowRun")}</TableHead>
            <TableHead>{t("trigger")}</TableHead>
            <TableHead>{t("status")}</TableHead>
            <TableHead>{t("pullRequest")}</TableHead>
            <TableHead>{t("ticket")}</TableHead>
            <TableHead>{t("worktree")}</TableHead>
            <TableHead>{t("started")}</TableHead>
            <TableHead className="text-right">{t("actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => {
            const key = runKey(run);
            const expanded = expandedRuns.has(key);
            const jobState = jobStates[key];
            const pipeline: GitHubPipelineView = {
              id: run.id,
              name: run.name,
              status: run.status,
              url: run.url,
              checkSuiteId: run.checkSuiteId,
              canRetry: run.canRetry,
              retryUnavailableReason: run.retryUnavailableReason,
              jobs: [],
            };
            return (
              <Fragment key={key}>
                <TableRow>
                  <TableCell className="pr-0">
                    <Button
                      aria-expanded={expanded}
                      aria-label={t(expanded ? "hideJobs" : "showJobs", {
                        run: run.displayTitle,
                      })}
                      onClick={() => onToggleRun(run)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      {expanded ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <a
                      className="font-medium text-primary hover:underline"
                      href={run.repositoryUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {run.repositoryNameWithOwner}
                    </a>
                  </TableCell>
                  <TableCell className="min-w-72 whitespace-normal">
                    <p className="font-medium">{run.name}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {run.displayTitle}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("runNumber", { number: run.runNumber })}
                      {run.runAttempt > 1
                        ? ` · ${t("attempt", { attempt: run.runAttempt })}`
                        : ""}
                    </p>
                  </TableCell>
                  <TableCell className="min-w-48 whitespace-normal">
                    <p>{run.event}</p>
                    <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                      {run.headBranch ?? run.headSha.slice(0, 7)}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge className={pipelineStateClass(run.status)}>
                      {tp(`pipelineStates.${run.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {run.pullRequests.length === 0 ? (
                      "—"
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {run.pullRequests.map((pullRequest) => (
                          <Link
                            className="font-medium text-primary hover:underline"
                            href={pullRequestDetailHref({
                              repositoryNameWithOwner:
                                run.repositoryNameWithOwner,
                              number: pullRequest.number,
                            })}
                            key={pullRequest.number}
                          >
                            #{pullRequest.number}
                          </Link>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {run.jiraKey ? (
                      <Badge
                        asChild
                        className="cursor-pointer hover:bg-muted/80"
                      >
                        <button
                          onClick={() => replaceIssueParam(run.jiraKey)}
                          type="button"
                        >
                          {run.jiraKey}
                        </button>
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {run.worktreeId ? (
                      <Link
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                        href={worktreeDetailHref(run.worktreeId)}
                      >
                        <GitBranch className="size-3.5" />
                        {t("viewWorktree")}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <time dateTime={run.createdAt} title={run.createdAt}>
                      {relativeAge(run.createdAt, locale)}
                    </time>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button asChild size="sm" variant="outline">
                        <a href={run.url} rel="noreferrer" target="_blank">
                          {t("view")}
                          <ExternalLink />
                        </a>
                      </Button>
                      <RetryPipelineButton
                        onError={onError}
                        onPipelineRetried={() => onRunRetried(run)}
                        pipeline={pipeline}
                        repositoryId={run.repositoryGithubId}
                      />
                    </div>
                  </TableCell>
                </TableRow>
                {expanded && (
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    <TableCell className="p-0" colSpan={10}>
                      <WorkflowJobsPanel
                        onError={onError}
                        onReload={() => onLoadJobs(run)}
                        onRetried={(jobId) => onJobRetried(run, jobId)}
                        run={run}
                        state={jobState}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function WorkflowJobsPanel({
  run,
  state,
  onReload,
  onRetried,
  onError,
}: {
  run: GitHubActionsWorkflowRunView;
  state: JobState | undefined;
  onReload: () => void;
  onRetried: (jobId: string) => void;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("actionsPage");

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
            <Button onClick={onReload} size="sm" variant="outline">
              <RefreshCw /> {t("retryLoad")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : state?.jobs?.length === 0 ? (
        <p className="px-2 py-3 text-sm text-muted-foreground">{t("noJobs")}</p>
      ) : state?.jobs ? (
        <div className="divide-y">
          {state.jobs.map((job) => (
            <WorkflowJob
              checkSuiteId={run.checkSuiteId}
              job={job}
              key={job.id}
              onError={onError}
              onRetried={() => onRetried(job.id)}
              repositoryId={run.repositoryGithubId}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowJob({
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
  const t = useTranslations("actionsPage");
  const tp = useTranslations("pullRequests");
  const [expanded, setExpanded] = useState(false);
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
        {job.url ? (
          <Button asChild size="sm" variant="outline">
            <a href={job.url} rel="noreferrer" target="_blank">
              {t("view")}
              <ExternalLink />
            </a>
          </Button>
        ) : (
          <Button disabled size="sm" variant="outline">
            {t("view")}
            <ExternalLink />
          </Button>
        )}
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
