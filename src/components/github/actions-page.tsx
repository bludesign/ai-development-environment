"use client";

import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  MoreHorizontal,
  PlayCircle,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import {
  Fragment,
  MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { pipelineStateClass } from "@/components/github/pipeline-menu";
import { pullRequestDetailHref } from "@/components/github/pull-request-links";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  GitHubSettingsView,
  GitHubWorkflowJobView,
} from "@/services/github/types";
import { worktreeDetailHref } from "@/components/worktrees/worktree-navigation";

const ALL_REPOSITORIES = "all";
const RUN_FIELDS =
  "id repositoryGithubId codebaseRepositoryId repositoryNameWithOwner repositoryUrl name displayTitle runNumber runAttempt event status url headBranch headSha checkSuiteId canRetry retryUnavailableReason pullRequests { number url } jiraKey worktreeId startedAt createdAt updatedAt";
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

function runDuration(run: GitHubActionsWorkflowRunView) {
  const startedAt = Date.parse(run.startedAt);
  const active =
    run.status === "ACTION_REQUIRED" ||
    run.status === "EXPECTED" ||
    run.status === "IN_PROGRESS" ||
    run.status === "PENDING" ||
    run.status === "QUEUED";
  const finishedAt = active ? Date.now() : Date.parse(run.updatedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return "—";
  const totalSeconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
  return `${seconds}s`;
}

function shouldToggleRunRow(event: MouseEvent<HTMLTableRowElement>) {
  if (event.defaultPrevented || event.button !== 0) return false;
  const target = event.target;
  if (!(target instanceof Element) || !event.currentTarget.contains(target)) {
    return false;
  }
  return !target.closest(
    "a, button, input, select, textarea, [role='button'], [role='link'], [role='menuitem']",
  );
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
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [jobStates, setJobStates] = useState<Record<string, JobState>>({});
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);
  const requestGenerationRef = useRef(0);
  const appendInFlightGenerationRef = useRef<number | null>(null);

  const loadRuns = useCallback(
    async (
      repositoryId: string,
      options: { append: boolean; cursor?: string | null } = {
        append: false,
      },
    ) => {
      const generation = options.append
        ? requestGenerationRef.current
        : ++requestGenerationRef.current;
      if (options.append) {
        if (
          !options.cursor ||
          appendInFlightGenerationRef.current === generation
        ) {
          return;
        }
        appendInFlightGenerationRef.current = generation;
        setLoadingMore(true);
        setPaginationError(null);
      } else {
        appendInFlightGenerationRef.current = null;
        setLoading(true);
        setLoadingMore(false);
        setPaginationError(null);
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
        if (generation !== requestGenerationRef.current) return;
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
        setPaginationError(null);
      } catch (value) {
        if (generation !== requestGenerationRef.current) return;
        const message = value instanceof Error ? value.message : String(value);
        if (options.append) setPaginationError(message);
        else setError(message);
      } finally {
        if (options.append) {
          if (appendInFlightGenerationRef.current === generation) {
            appendInFlightGenerationRef.current = null;
            setLoadingMore(false);
          }
        } else if (generation === requestGenerationRef.current) {
          setLoading(false);
        }
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

  useEffect(() => {
    if (
      !settings?.tokenConfigured ||
      !hasNextPage ||
      !endCursor ||
      loading ||
      loadingMore ||
      paginationError
    ) {
      return;
    }
    const trigger = loadMoreTriggerRef.current;
    if (!trigger) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void loadRuns(selectedRepositoryId, {
          append: true,
          cursor: endCursor,
        });
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [
    endCursor,
    hasNextPage,
    loadRuns,
    loading,
    loadingMore,
    paginationError,
    selectedRepositoryId,
    settings?.tokenConfigured,
  ]);

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

          {paginationError && hasNextPage ? (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{paginationError}</span>
                <Button
                  disabled={loadingMore || !endCursor}
                  onClick={() =>
                    void loadRuns(selectedRepositoryId, {
                      append: true,
                      cursor: endCursor,
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw /> {t("retryLoad")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : hasNextPage ? (
            <div
              className="flex min-h-10 items-center justify-center gap-2 text-sm text-muted-foreground"
              ref={loadMoreTriggerRef}
              role="status"
            >
              {loadingMore && (
                <>
                  <Spinner /> {t("loadingMore")}
                </>
              )}
            </div>
          ) : null}
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
  const groupedRuns = useMemo(() => {
    const groups = new Map<
      string,
      { label: string; items: GitHubActionsWorkflowRunView[] }
    >();
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
    for (const run of runs) {
      const date = new Date(run.createdAt);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const group = groups.get(key) ?? {
        label: formatter.format(date),
        items: [],
      };
      group.items.push(run);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
  }, [locale, runs]);

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <span className="sr-only">{t("expand")}</span>
            </TableHead>
            <TableHead>
              {t("workflowRun")} / {t("repository")}
            </TableHead>
            <TableHead>{t("trigger")}</TableHead>
            <TableHead>{t("status")}</TableHead>
            <TableHead>{t("pullRequest")}</TableHead>
            <TableHead>{t("ticket")}</TableHead>
            <TableHead>{t("started")}</TableHead>
            <TableHead className="text-right">{t("actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groupedRuns.map((group) => (
            <Fragment key={group.key}>
              <TableRow className="bg-muted/20 hover:bg-muted/20">
                <TableCell
                  className="py-1.5 text-xs font-normal text-muted-foreground"
                  colSpan={8}
                >
                  {group.label}
                </TableCell>
              </TableRow>
              {group.items.map((run) => {
                const key = runKey(run);
                const expanded = expandedRuns.has(key);
                const jobState = jobStates[key];
                return (
                  <Fragment key={key}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={(event) => {
                        if (shouldToggleRunRow(event)) onToggleRun(run);
                      }}
                    >
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
                      <TableCell className="min-w-72 whitespace-normal">
                        <a
                          className="block rounded-md px-2 py-1.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          href={run.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <span className="flex items-center gap-1 font-medium text-primary">
                            {run.name}
                            <ExternalLink className="size-3.5 shrink-0" />
                          </span>
                          <span className="mt-0.5 block text-sm text-foreground">
                            {run.displayTitle}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {run.repositoryNameWithOwner} ·{" "}
                            {t("runNumber", { number: run.runNumber })}
                            {run.runAttempt > 1
                              ? ` · ${t("attempt", { attempt: run.runAttempt })}`
                              : ""}
                          </span>
                        </a>
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
                              <Badge
                                asChild
                                className="cursor-pointer hover:bg-muted/80"
                                key={pullRequest.number}
                              >
                                <Link
                                  href={pullRequestDetailHref({
                                    repositoryNameWithOwner:
                                      run.repositoryNameWithOwner,
                                    number: pullRequest.number,
                                  })}
                                >
                                  #{pullRequest.number}
                                </Link>
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {run.jiraKey ? (
                          <Badge
                            asChild
                            className="cursor-pointer hover:bg-primary/80"
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
                      <TableCell className="text-muted-foreground">
                        <div className="flex flex-col gap-0.5">
                          <time dateTime={run.startedAt} title={run.startedAt}>
                            {relativeAge(run.startedAt, locale)}
                          </time>
                          <span className="text-xs">
                            {t("duration", { duration: runDuration(run) })}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <WorkflowRunActionsMenu
                            onError={onError}
                            onRetried={() => onRunRetried(run)}
                            run={run}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell className="p-0" colSpan={8}>
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
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function WorkflowRunActionsMenu({
  run,
  onRetried,
  onError,
}: {
  run: GitHubActionsWorkflowRunView;
  onRetried: () => void;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("actionsPage");
  const tp = useTranslations("pullRequests");
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    if (!run.canRetry || !run.checkSuiteId) return;
    setRetrying(true);
    try {
      await controlPlaneRequest<{ retryGitHubPipeline: { id: string } }>(
        `mutation RetryGitHubPipeline(
          $repositoryId: ID!
          $checkSuiteId: ID!
        ) {
          retryGitHubPipeline(
            repositoryId: $repositoryId
            checkSuiteId: $checkSuiteId
          ) { id }
        }`,
        {
          repositoryId: run.repositoryGithubId,
          checkSuiteId: run.checkSuiteId,
        },
      );
      onRetried();
      onError(null);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      setRetrying(false);
    }
  };

  const retryUnavailableMessage = run.retryUnavailableReason
    ? tp(`retryUnavailable.${run.retryUnavailableReason}`)
    : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`${t("actions")}: ${run.displayTitle}`}
          size="icon-sm"
          variant="outline"
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem asChild>
          <a href={run.url} rel="noreferrer" target="_blank">
            <ExternalLink />
            {t("view")}
          </a>
        </DropdownMenuItem>
        {run.worktreeId ? (
          <DropdownMenuItem asChild>
            <Link href={worktreeDetailHref(run.worktreeId)}>
              <GitBranch />
              {t("worktree")}
            </Link>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled>
            <GitBranch />
            {t("worktree")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={retrying || !run.canRetry || !run.checkSuiteId}
          onSelect={() => void retry()}
          title={retryUnavailableMessage}
        >
          {retrying ? <Spinner /> : <RotateCcw />}
          {retrying ? tp("retrying") : tp("retry")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
