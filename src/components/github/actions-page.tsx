"use client";

import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import {
  FormEvent,
  Fragment,
  MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { pipelineStateClass } from "@/components/github/pipeline-menu";
import { WorkflowAttemptSelect } from "@/components/github/workflow-attempt-select";
import { WorkflowRunActionsMenu } from "@/components/github/workflow-run-actions-menu";
import { pullRequestDetailHref } from "@/components/github/pull-request-links";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DateTime } from "@/components/common/date-time";
import { Input } from "@/components/ui/input";
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
} from "@/components/common/searchable-select";
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
import { dayKey, formatDateValue } from "@/lib/date-format";
import type {
  GitHubActionsRepositoryErrorView,
  GitHubActionsRepositoryView,
  GitHubActionsWorkflowRunPage,
  GitHubActionsWorkflowRunView,
  GitHubSettingsView,
  GitHubWorkflowJobView,
  GitHubWorkflowRunAttemptView,
} from "@/services/github/types";

const ALL_REPOSITORIES = "all";
const ALL_PIPELINES = "all";
const RUN_FIELDS =
  "id workflowId repositoryGithubId codebaseRepositoryId repositoryNameWithOwner repositoryUrl name displayTitle runNumber runAttempt event status url headBranch headSha checkSuiteId canRetry retryUnavailableReason pullRequests { number url } jiraKey worktreeId startedAt createdAt updatedAt";
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

function replaceFilterParams(
  repositoryId: string,
  branch: string,
  pipeline: string,
) {
  const params = new URLSearchParams(window.location.search);
  if (repositoryId === ALL_REPOSITORIES) {
    params.delete("repository");
    params.delete("branch");
    params.delete("pipeline");
  } else {
    params.set("repository", repositoryId);
    if (branch) params.set("branch", branch);
    else params.delete("branch");
    if (pipeline && pipeline !== ALL_PIPELINES) {
      params.set("pipeline", pipeline);
    } else {
      params.delete("pipeline");
    }
  }
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}`,
  );
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
  const initialFiltersRef = useRef({
    repositoryId: searchParams.get("repository")?.trim() || ALL_REPOSITORIES,
    branch: searchParams.get("branch")?.trim() || "",
    pipeline: searchParams.get("pipeline")?.trim() || ALL_PIPELINES,
  });
  const [settings, setSettings] = useState<GitHubSettingsView | null>(null);
  const [configurationLoading, setConfigurationLoading] = useState(true);
  const [runs, setRuns] = useState<GitHubActionsWorkflowRunView[]>([]);
  const [repositories, setRepositories] = useState<
    GitHubActionsRepositoryView[]
  >([]);
  const [repositoryErrors, setRepositoryErrors] = useState<
    GitHubActionsRepositoryErrorView[]
  >([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(
    initialFiltersRef.current.repositoryId,
  );
  const [selectedBranch, setSelectedBranch] = useState(
    initialFiltersRef.current.repositoryId === ALL_REPOSITORIES
      ? ""
      : initialFiltersRef.current.branch,
  );
  const [branchInput, setBranchInput] = useState(
    initialFiltersRef.current.repositoryId === ALL_REPOSITORIES
      ? ""
      : initialFiltersRef.current.branch,
  );
  const [selectedPipeline, setSelectedPipeline] = useState(
    initialFiltersRef.current.repositoryId === ALL_REPOSITORIES
      ? ALL_PIPELINES
      : initialFiltersRef.current.pipeline,
  );
  const [knownPipelines, setKnownPipelines] = useState<Record<string, string>>(
    {},
  );
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
      branch: string,
      pipeline: string,
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
            $branch: String
            $workflowId: ID
            $first: Int!
            $after: String
          ) {
            githubActionsWorkflowRuns(
              codebaseRepositoryId: $codebaseRepositoryId
              branch: $branch
              workflowId: $workflowId
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
            branch:
              repositoryId === ALL_REPOSITORIES || !branch ? null : branch,
            workflowId:
              repositoryId === ALL_REPOSITORIES || pipeline === ALL_PIPELINES
                ? null
                : pipeline,
            first: 25,
            after: options.cursor ?? null,
          },
        );
        if (generation !== requestGenerationRef.current) return;
        const page = data.githubActionsWorkflowRuns;
        if (repositoryId !== ALL_REPOSITORIES) {
          const pagePipelines = Object.fromEntries(
            page.items.map((run) => [run.workflowId, run.name]),
          );
          setKnownPipelines((current) =>
            !options.append && pipeline === ALL_PIPELINES
              ? pagePipelines
              : { ...current, ...pagePipelines },
          );
        }
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
          const initialFilters = initialFiltersRef.current;
          await loadRuns(
            initialFilters.repositoryId,
            initialFilters.repositoryId === ALL_REPOSITORIES
              ? ""
              : initialFilters.branch,
            initialFilters.repositoryId === ALL_REPOSITORIES
              ? ALL_PIPELINES
              : initialFilters.pipeline,
          );
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
        void loadRuns(selectedRepositoryId, selectedBranch, selectedPipeline, {
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
    selectedBranch,
    selectedPipeline,
    settings?.tokenConfigured,
  ]);

  const selectRepository = (repositoryId: string) => {
    setSelectedRepositoryId(repositoryId);
    setSelectedBranch("");
    setBranchInput("");
    setSelectedPipeline(ALL_PIPELINES);
    setKnownPipelines({});
    replaceFilterParams(repositoryId, "", ALL_PIPELINES);
    void loadRuns(repositoryId, "", ALL_PIPELINES);
  };

  const applyBranchFilter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const branch = branchInput.trim();
    setBranchInput(branch);
    setSelectedBranch(branch);
    replaceFilterParams(selectedRepositoryId, branch, selectedPipeline);
    void loadRuns(selectedRepositoryId, branch, selectedPipeline);
  };

  const clearBranchFilter = () => {
    setBranchInput("");
    if (!selectedBranch) return;
    setSelectedBranch("");
    replaceFilterParams(selectedRepositoryId, "", selectedPipeline);
    void loadRuns(selectedRepositoryId, "", selectedPipeline);
  };

  const selectPipeline = (pipeline: string) => {
    setSelectedPipeline(pipeline);
    replaceFilterParams(selectedRepositoryId, selectedBranch, pipeline);
    void loadRuns(selectedRepositoryId, selectedBranch, pipeline);
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

  const runCancelled = (run: GitHubActionsWorkflowRunView) => {
    const key = runKey(run);
    setRuns((current) =>
      current.map((item) =>
        runKey(item) === key
          ? {
              ...item,
              status: "CANCELLED",
              canRetry: false,
              retryUnavailableReason: "NOT_COMPLETED",
              updatedAt: new Date().toISOString(),
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
  const pipelineNames = new Map(Object.entries(knownPipelines));
  if (
    selectedPipeline !== ALL_PIPELINES &&
    !pipelineNames.has(selectedPipeline)
  ) {
    pipelineNames.set(selectedPipeline, selectedPipeline);
  }
  const pipelineOptions: SearchableSelectOption[] = [
    {
      value: ALL_PIPELINES,
      label: t("allPipelines"),
      keywords: t("allPipelines"),
    },
    ...[...pipelineNames.entries()]
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([id, name]) => ({ value: id, label: name, keywords: name })),
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
          onClick={() =>
            void loadRuns(
              selectedRepositoryId,
              selectedBranch,
              selectedPipeline,
            )
          }
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
            <div className="grid max-w-6xl gap-3 sm:grid-cols-3">
              <SearchableSelect
                ariaLabel={t("repositoryFilter")}
                emptyMessage={t("noRepositoryMatches")}
                onValueChange={selectRepository}
                options={repositoryOptions}
                placeholder={t("repositoryFilter")}
                searchPlaceholder={t("searchRepositories")}
                value={selectedRepositoryId}
              />
              {selectedRepositoryId !== ALL_REPOSITORIES && (
                <>
                  <form className="flex gap-2" onSubmit={applyBranchFilter}>
                    <Input
                      aria-label={t("branchFilter")}
                      autoCapitalize="none"
                      onChange={(event) => setBranchInput(event.target.value)}
                      placeholder={t("branchFilterPlaceholder")}
                      spellCheck={false}
                      value={branchInput}
                    />
                    <Button disabled={loading} type="submit" variant="outline">
                      {t("applyBranchFilter")}
                    </Button>
                    {(branchInput || selectedBranch) && (
                      <Button
                        aria-label={t("clearBranchFilter")}
                        disabled={loading}
                        onClick={clearBranchFilter}
                        size="icon"
                        title={t("clearBranchFilter")}
                        type="button"
                        variant="ghost"
                      >
                        <X />
                      </Button>
                    )}
                  </form>
                  <SearchableSelect
                    ariaLabel={t("pipelineFilter")}
                    emptyMessage={t("noPipelineMatches")}
                    onValueChange={selectPipeline}
                    options={pipelineOptions}
                    placeholder={t("pipelineFilter")}
                    searchPlaceholder={t("searchPipelines")}
                    value={selectedPipeline}
                  />
                </>
              )}
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
              onRunCancelled={runCancelled}
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
                    void loadRuns(
                      selectedRepositoryId,
                      selectedBranch,
                      selectedPipeline,
                      {
                        append: true,
                        cursor: endCursor,
                      },
                    )
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
  onRunCancelled,
  onJobRetried,
  onError,
}: {
  runs: GitHubActionsWorkflowRunView[];
  expandedRuns: Set<string>;
  jobStates: Record<string, JobState>;
  onToggleRun: (run: GitHubActionsWorkflowRunView) => void;
  onLoadJobs: (run: GitHubActionsWorkflowRunView) => void;
  onRunRetried: (run: GitHubActionsWorkflowRunView) => void;
  onRunCancelled: (run: GitHubActionsWorkflowRunView) => void;
  onJobRetried: (run: GitHubActionsWorkflowRunView, jobId: string) => void;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("actionsPage");
  const tp = useTranslations("pullRequests");
  const locale = useLocale();
  const [historicalAttempts, setHistoricalAttempts] = useState<
    Record<string, GitHubWorkflowRunAttemptView | null>
  >({});
  const groupedRuns = useMemo(() => {
    const groups = new Map<
      string,
      { label: string; items: GitHubActionsWorkflowRunView[] }
    >();
    for (const run of runs) {
      // Keyed on creation, not start: a rerun of an old workflow belongs to the
      // day it was created, which is also the order the paginated API returns.
      const date = new Date(run.createdAt);
      const key = dayKey(date) ?? run.createdAt;
      const group = groups.get(key) ?? {
        label: formatDateValue(date, "long", { locale, showTime: false }),
        items: [],
      };
      group.items.push(run);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
  }, [locale, runs]);

  return (
    <Card className="gap-0 py-0">
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
                const historicalAttempt = historicalAttempts[key] ?? null;
                const displayedRun = historicalAttempt
                  ? {
                      ...run,
                      status: historicalAttempt.status,
                      url: historicalAttempt.url,
                      startedAt: historicalAttempt.startedAt,
                      createdAt: historicalAttempt.createdAt,
                      updatedAt: historicalAttempt.updatedAt,
                    }
                  : run;
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
                          href={displayedRun.url}
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
                        <div className="mt-1 px-2">
                          <WorkflowAttemptSelect
                            latestAttempt={run.runAttempt}
                            onAttemptChange={(attempt) =>
                              setHistoricalAttempts((current) => ({
                                ...current,
                                [key]: attempt,
                              }))
                            }
                            repositoryId={run.codebaseRepositoryId}
                            workflowRunId={run.id}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="min-w-48 whitespace-normal">
                        <p>{run.event}</p>
                        <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                          {run.headBranch ?? run.headSha.slice(0, 7)}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={pipelineStateClass(displayedRun.status)}
                        >
                          {tp(`pipelineStates.${displayedRun.status}`)}
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
                          <DateTime
                            kind="time"
                            relativeToday
                            value={displayedRun.startedAt}
                          />
                          <span className="text-xs">
                            {t("duration", {
                              duration: runDuration(displayedRun),
                            })}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <WorkflowRunActionsMenu
                            includeAutoRetry
                            includeWorktree
                            onCancelled={() => onRunCancelled(run)}
                            onError={onError}
                            onRetried={() => onRunRetried(run)}
                            run={run}
                            jobs={jobState?.jobs ?? []}
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
                            state={
                              historicalAttempt
                                ? {
                                    loading: false,
                                    error: null,
                                    jobs: historicalAttempt.jobs,
                                  }
                                : jobState
                            }
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
    </Card>
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
