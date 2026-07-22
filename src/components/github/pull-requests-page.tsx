"use client";

import {
  ExternalLink,
  FileText,
  GitMerge,
  GitPullRequest,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import {
  Fragment,
  FormEvent,
  MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { MergePullRequestButton } from "@/components/github/merge-pull-request-button";
import { PipelineMenu } from "@/components/github/pipeline-menu";
import {
  pullRequestCommentsHref,
  pullRequestDetailHref,
} from "@/components/github/pull-request-links";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DateTime } from "@/components/ui/date-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Item } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { dayKey, formatDateValue } from "@/lib/date-format";
import type {
  GitHubPipelineView,
  GitHubPullRequestPage,
  GitHubPullRequestScope,
  GitHubPullRequestStateFilter,
  GitHubPullRequestView,
  GitHubRepositoryCandidate,
  GitHubRepositoryCandidatePage,
  GitHubRepositoryView,
  GitHubReviewDecision,
  GitHubSettingsView,
} from "@/services/github/types";

const REPOSITORY_FIELDS =
  "id githubId owner name nameWithOwner url jiraKeyRegex";
const PULL_REQUEST_FIELDS =
  "id number title url repositoryGithubId repositoryNameWithOwner repositoryUrl labels jiraKey pipelineStatus pipelines { id name status url checkSuiteId canRetry retryUnavailableReason } reviewDecision unresolvedReviewThreadCount state headRefName createdAt";

type TabKey = "mine" | "review" | "repositories";

function pullRequestPageKey(
  tab: TabKey,
  repositoryId: string,
  state: GitHubPullRequestStateFilter,
) {
  return tab === "repositories"
    ? `${state}:repository:${repositoryId}`
    : `${state}:${tab}`;
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

function reviewClass(decision: GitHubReviewDecision) {
  if (decision === "APPROVED")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (decision === "CHANGES_REQUESTED")
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (decision === "REVIEW_REQUIRED")
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
}

function validateRegex(pattern: string): string | null {
  if (!pattern.trim()) return null;
  try {
    void new RegExp(pattern, "i");
    return null;
  } catch {
    return "invalid";
  }
}

export function PullRequestsPage() {
  const t = useTranslations("pullRequests");
  const searchParams = useSearchParams();
  const locale = useLocale();
  const issueKey = searchParams.get("issue");
  const [settings, setSettings] = useState<GitHubSettingsView | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepositoryView[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("mine");
  const [pullRequestState, setPullRequestState] =
    useState<GitHubPullRequestStateFilter>("OPEN");
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [pages, setPages] = useState<Record<string, GitHubPullRequestPage>>({});
  const [loadingTabs, setLoadingTabs] = useState<Record<string, boolean>>({});
  const [loadingMoreTabs, setLoadingMoreTabs] = useState<
    Record<string, boolean>
  >({});
  const [paginationErrors, setPaginationErrors] = useState<
    Record<string, string | null>
  >({});
  const [configurationLoading, setConfigurationLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);
  const requestGenerationsRef = useRef<Record<string, number>>({});
  const appendInFlightGenerationsRef = useRef<Record<string, number>>({});

  const loadConfiguration = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        githubSettings: GitHubSettingsView;
        githubRepositories: GitHubRepositoryView[];
      }>(`query GitHubPullRequestConfiguration {
        githubSettings { tokenConfigured defaultJiraKeyRegex updatedAt }
        githubRepositories { ${REPOSITORY_FIELDS} }
      }`);
      setSettings(data.githubSettings);
      setRepositories(data.githubRepositories);
      setSelectedRepositoryId((current) =>
        data.githubRepositories.some((repository) => repository.id === current)
          ? current
          : (data.githubRepositories[0]?.id ?? ""),
      );
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setConfigurationLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadConfiguration(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadConfiguration]);

  const loadTab = useCallback(
    async (
      tab: TabKey,
      repositoryId: string,
      state: GitHubPullRequestStateFilter,
      options: { append: boolean; cursor?: string | null } = {
        append: false,
      },
    ) => {
      const pageKey = pullRequestPageKey(tab, repositoryId, state);
      if (tab === "repositories" && !repositoryId) return;
      const currentGeneration = requestGenerationsRef.current[pageKey] ?? 0;
      const generation = options.append
        ? currentGeneration
        : currentGeneration + 1;
      if (options.append) {
        if (
          !options.cursor ||
          appendInFlightGenerationsRef.current[pageKey] === generation
        ) {
          return;
        }
        appendInFlightGenerationsRef.current[pageKey] = generation;
        setLoadingMoreTabs((current) => ({
          ...current,
          [pageKey]: true,
        }));
      } else {
        requestGenerationsRef.current[pageKey] = generation;
        delete appendInFlightGenerationsRef.current[pageKey];
        setLoadingTabs((current) => ({ ...current, [pageKey]: true }));
        setLoadingMoreTabs((current) => ({
          ...current,
          [pageKey]: false,
        }));
      }
      setPaginationErrors((current) => ({
        ...current,
        [pageKey]: null,
      }));
      try {
        const scopedRepositoryId = tab === "repositories" ? repositoryId : null;
        const scope: GitHubPullRequestScope = scopedRepositoryId
          ? "REPOSITORY"
          : tab === "review"
            ? "REVIEW_REQUESTED"
            : "MINE";
        const data = await controlPlaneRequest<{
          githubPullRequests: GitHubPullRequestPage;
        }>(
          `query GitHubPullRequests(
            $scope: GitHubPullRequestScope!
            $repositoryId: ID
            $state: GitHubPullRequestStateFilter!
            $first: Int!
            $after: String
          ) {
            githubPullRequests(
              scope: $scope
              repositoryId: $repositoryId
              state: $state
              first: $first
              after: $after
            ) {
              items { ${PULL_REQUEST_FIELDS} }
              truncated
              hasNextPage
              endCursor
            }
          }`,
          {
            scope,
            repositoryId: scopedRepositoryId,
            state,
            first: 25,
            after: options.cursor ?? null,
          },
        );
        if (requestGenerationsRef.current[pageKey] !== generation) return;
        setPages((current) => ({
          ...current,
          [pageKey]:
            options.append && current[pageKey]
              ? {
                  ...data.githubPullRequests,
                  items: [
                    ...current[pageKey].items,
                    ...data.githubPullRequests.items.filter(
                      (item) =>
                        !current[pageKey].items.some(
                          (existing) => existing.id === item.id,
                        ),
                    ),
                  ],
                }
              : data.githubPullRequests,
        }));
        setError(null);
      } catch (value) {
        if (requestGenerationsRef.current[pageKey] !== generation) return;
        const message = value instanceof Error ? value.message : String(value);
        if (options.append) {
          setPaginationErrors((current) => ({
            ...current,
            [pageKey]: message,
          }));
        } else {
          setError(message);
        }
      } finally {
        if (options.append) {
          if (appendInFlightGenerationsRef.current[pageKey] === generation) {
            delete appendInFlightGenerationsRef.current[pageKey];
            setLoadingMoreTabs((current) => ({
              ...current,
              [pageKey]: false,
            }));
          }
        } else if (requestGenerationsRef.current[pageKey] === generation) {
          setLoadingTabs((current) => ({ ...current, [pageKey]: false }));
        }
      }
    },
    [],
  );

  const pageKey = pullRequestPageKey(
    activeTab,
    selectedRepositoryId,
    pullRequestState,
  );

  useEffect(() => {
    if (
      settings?.tokenConfigured &&
      (activeTab !== "repositories" || selectedRepositoryId) &&
      !pages[pageKey] &&
      !loadingTabs[pageKey]
    ) {
      const timeout = window.setTimeout(
        () => void loadTab(activeTab, selectedRepositoryId, pullRequestState),
        0,
      );
      return () => window.clearTimeout(timeout);
    }
  }, [
    activeTab,
    loadTab,
    loadingTabs,
    pageKey,
    pages,
    pullRequestState,
    selectedRepositoryId,
    settings?.tokenConfigured,
  ]);

  useEffect(() => {
    if (
      !repositories.some((repository) => repository.id === selectedRepositoryId)
    ) {
      const timeout = window.setTimeout(
        () => setSelectedRepositoryId(repositories[0]?.id ?? ""),
        0,
      );
      return () => window.clearTimeout(timeout);
    }
  }, [repositories, selectedRepositoryId]);

  const page = pages[pageKey];
  const loading = Boolean(loadingTabs[pageKey]);
  const loadingMore = Boolean(loadingMoreTabs[pageKey]);
  const paginationError = paginationErrors[pageKey] ?? null;

  useEffect(() => {
    if (
      !settings?.tokenConfigured ||
      !page?.hasNextPage ||
      !page.endCursor ||
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
        void loadTab(activeTab, selectedRepositoryId, pullRequestState, {
          append: true,
          cursor: page.endCursor,
        });
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [
    activeTab,
    loadTab,
    loading,
    loadingMore,
    page?.endCursor,
    page?.hasNextPage,
    paginationError,
    pullRequestState,
    selectedRepositoryId,
    settings?.tokenConfigured,
  ]);

  const repositoriesChanged = (next: GitHubRepositoryView[]) => {
    setRepositories(next);
    setPages({});
    setSelectedRepositoryId((current) =>
      next.some((repository) => repository.id === current)
        ? current
        : (next[0]?.id ?? ""),
    );
  };

  const settingsChanged = (next: GitHubSettingsView) => {
    setSettings(next);
    setPages({});
  };

  const pipelineRetried = (
    pullRequestId: string,
    pipeline: GitHubPipelineView,
  ) => {
    setPages((current) => {
      const currentPage = current[pageKey];
      if (!currentPage) return current;
      return {
        ...current,
        [pageKey]: {
          ...currentPage,
          items: currentPage.items.map((pullRequest) =>
            pullRequest.id === pullRequestId
              ? {
                  ...pullRequest,
                  pipelineStatus: "PENDING",
                  pipelines: pullRequest.pipelines.map((item) =>
                    item.id === pipeline.id ? pipeline : item,
                  ),
                }
              : pullRequest,
          ),
        },
      };
    });
  };

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
        <div className="flex gap-2">
          <Button
            disabled={!settings?.tokenConfigured || loading}
            onClick={() =>
              void loadTab(activeTab, selectedRepositoryId, pullRequestState)
            }
            variant="outline"
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
          <Button onClick={() => setManagerOpen(true)}>
            <Settings2 />
            {t("manage")}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {configurationLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loading")}
        </div>
      ) : !settings?.tokenConfigured ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitPullRequest />
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
          <div className="overflow-x-auto pb-1">
            <Tabs
              onValueChange={(value) => setActiveTab(value as TabKey)}
              value={activeTab}
            >
              <TabsList aria-label={t("tabsLabel")}>
                <TabsTrigger value="mine">{t("mine")}</TabsTrigger>
                <TabsTrigger value="review">{t("reviewRequests")}</TabsTrigger>
                <TabsTrigger value="repositories">
                  {t("repositories")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Select
              onValueChange={(value) =>
                setPullRequestState(value as GitHubPullRequestStateFilter)
              }
              value={pullRequestState}
            >
              <SelectTrigger aria-label={t("stateFilter")} className="min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {(["ALL", "OPEN", "CLOSED", "MERGED"] as const).map((state) => (
                  <SelectItem key={state} value={state}>
                    {t(`pullRequestStates.${state}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeTab === "repositories" && repositories.length > 0 && (
              <div className="min-w-64 max-w-lg flex-1">
                <SearchableSelect
                  ariaLabel={t("repositoryFilter")}
                  emptyMessage={t("noRepositoryMatches")}
                  onValueChange={setSelectedRepositoryId}
                  options={repositories.map<SearchableSelectOption>(
                    (repository) => ({
                      value: repository.id,
                      label: repository.nameWithOwner,
                      keywords: `${repository.owner} ${repository.name}`,
                    }),
                  )}
                  placeholder={t("selectRepository")}
                  searchPlaceholder={t("searchRepositories")}
                  value={selectedRepositoryId}
                />
              </div>
            )}
          </div>

          {page?.truncated && (
            <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300">
              <AlertDescription className="text-current">
                {t("truncated")}
              </AlertDescription>
            </Alert>
          )}

          {activeTab === "repositories" && repositories.length === 0 ? (
            <Empty className="border py-12">
              <EmptyHeader>
                <EmptyTitle>{t("noManagedRepositories")}</EmptyTitle>
                <EmptyDescription>{t("manageDescription")}</EmptyDescription>
              </EmptyHeader>
              <Button className="mt-4" onClick={() => setManagerOpen(true)}>
                <Plus /> {t("addRepository")}
              </Button>
            </Empty>
          ) : loading && !page ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Spinner />
              {t("loadingPullRequests")}
            </div>
          ) : page?.items.length === 0 ? (
            <Empty className="border py-12">
              <EmptyHeader>
                <EmptyTitle>{t("empty")}</EmptyTitle>
                <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : page ? (
            <PullRequestTable
              items={page.items}
              locale={locale}
              onMerged={() =>
                loadTab(activeTab, selectedRepositoryId, pullRequestState)
              }
              onPipelineRetried={pipelineRetried}
            />
          ) : null}

          {page && page.items.length > 0 && paginationError ? (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{paginationError}</span>
                <Button
                  disabled={loadingMore || !page.endCursor}
                  onClick={() =>
                    void loadTab(
                      activeTab,
                      selectedRepositoryId,
                      pullRequestState,
                      { append: true, cursor: page.endCursor },
                    )
                  }
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw /> {t("retryLoad")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : page?.hasNextPage && page.items.length > 0 ? (
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

      <GitHubRepositoryManager
        key={settings?.updatedAt ?? "loading"}
        onRepositoriesChanged={repositoriesChanged}
        onSettingsChanged={settingsChanged}
        open={managerOpen}
        repositories={repositories}
        settings={settings}
        setOpen={setManagerOpen}
        tokenConfigured={Boolean(settings?.tokenConfigured)}
      />
      <JiraTicketDrawer
        issueKey={issueKey}
        onClose={() => replaceIssueParam(null)}
      />
    </section>
  );
}

function PullRequestTable({
  items,
  locale,
  onMerged,
  onPipelineRetried,
}: {
  items: GitHubPullRequestView[];
  locale: string;
  onMerged: () => void | Promise<void>;
  onPipelineRetried: (
    pullRequestId: string,
    pipeline: GitHubPipelineView,
  ) => void;
}) {
  const t = useTranslations("pullRequests");
  const router = useRouter();
  const stopRowClick = (event: MouseEvent) => event.stopPropagation();
  const groupedPullRequests = useMemo(() => {
    const groups: Array<{
      key: string;
      dateKey: string;
      label: string;
      items: GitHubPullRequestView[];
    }> = [];
    for (const pullRequest of items) {
      const date = new Date(pullRequest.createdAt);
      const dateKey = dayKey(date) ?? pullRequest.createdAt;
      const group = groups.at(-1);
      if (group?.dateKey === dateKey) {
        group.items.push(pullRequest);
      } else {
        groups.push({
          key: `${dateKey}-${pullRequest.id}`,
          dateKey,
          label: formatDateValue(date, "long", { locale, showTime: false }),
          items: [pullRequest],
        });
      }
    }
    return groups;
  }, [items, locale]);

  return (
    <Card className="gap-0 py-0">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t("number")}</TableHead>
            <TableHead>{t("pullRequestAndRepository")}</TableHead>
            <TableHead>{t("labels")}</TableHead>
            <TableHead>{t("ticket")}</TableHead>
            <TableHead>{t("pipeline")}</TableHead>
            <TableHead>{t("approval")}</TableHead>
            <TableHead>{t("openComments")}</TableHead>
            <TableHead>{t("age")}</TableHead>
            <TableHead className="text-right">{t("actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groupedPullRequests.map((group) => (
            <Fragment key={group.key}>
              <TableRow className="bg-muted/20 hover:bg-muted/20">
                <TableCell
                  className="py-1.5 text-xs font-normal text-muted-foreground"
                  colSpan={9}
                >
                  {group.label}
                </TableCell>
              </TableRow>
              {group.items.map((pullRequest) => (
                <TableRow
                  key={pullRequest.id}
                  className="cursor-pointer"
                  onClick={() =>
                    router.push(pullRequestDetailHref(pullRequest))
                  }
                >
                  <TableCell>
                    <Badge
                      asChild
                      className="cursor-pointer hover:bg-muted/80"
                      variant="outline"
                    >
                      <Link
                        href={pullRequestDetailHref(pullRequest)}
                        onClick={stopRowClick}
                      >
                        #{pullRequest.number}
                      </Link>
                    </Badge>
                  </TableCell>
                  <TableCell className="min-w-72 whitespace-normal">
                    <div className="space-y-1">
                      <Link
                        className="font-medium hover:underline"
                        href={pullRequestDetailHref(pullRequest)}
                        onClick={stopRowClick}
                      >
                        {pullRequest.title}
                      </Link>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <a
                          className="text-muted-foreground hover:text-foreground"
                          href={pullRequest.repositoryUrl}
                          onClick={stopRowClick}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {pullRequest.repositoryNameWithOwner}
                        </a>
                      </div>
                      <p className="font-mono text-xs break-all text-muted-foreground">
                        {pullRequest.headRefName}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="min-w-40 whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {pullRequest.labels.length > 0
                        ? pullRequest.labels.map((label) => (
                            <Badge key={label}>{label}</Badge>
                          ))
                        : "—"}
                    </div>
                  </TableCell>
                  <TableCell>
                    {pullRequest.jiraKey ? (
                      <Badge
                        asChild
                        className="cursor-pointer hover:bg-primary/80"
                      >
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            replaceIssueParam(pullRequest.jiraKey);
                          }}
                          type="button"
                        >
                          {pullRequest.jiraKey}
                        </button>
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <PipelineMenu
                      onPipelineRetried={(pipeline) =>
                        onPipelineRetried(pullRequest.id, pipeline)
                      }
                      pipelineStatus={pullRequest.pipelineStatus}
                      pipelines={pullRequest.pipelines}
                      repositoryId={pullRequest.repositoryGithubId}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge className={reviewClass(pullRequest.reviewDecision)}>
                      {t(`reviewStates.${pullRequest.reviewDecision}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      asChild
                      className={
                        pullRequest.unresolvedReviewThreadCount === 0
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      }
                    >
                      <Link
                        aria-label={t("viewOpenComments", {
                          count: pullRequest.unresolvedReviewThreadCount,
                        })}
                        href={pullRequestCommentsHref(pullRequest)}
                        onClick={stopRowClick}
                      >
                        {pullRequest.unresolvedReviewThreadCount}
                      </Link>
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    <div className="flex flex-col items-start gap-1.5">
                      <Badge variant="outline">
                        {t(`pullRequestStates.${pullRequest.state}`)}
                      </Badge>
                      <DateTime kind="relative" value={pullRequest.createdAt} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <PullRequestActionsMenu
                      onMerged={onMerged}
                      pullRequest={pullRequest}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function PullRequestActionsMenu({
  pullRequest,
  onMerged,
}: {
  pullRequest: GitHubPullRequestView;
  onMerged: () => void | Promise<void>;
}) {
  const t = useTranslations("pullRequests");
  const [mergeOpen, setMergeOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`${t("actions")}: #${pullRequest.number}`}
            onClick={(event) => event.stopPropagation()}
            size="icon-sm"
            variant="outline"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem asChild>
            <Link href={pullRequestDetailHref(pullRequest)}>
              <FileText />
              {t("details")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={pullRequest.url} rel="noreferrer" target="_blank">
              <ExternalLink />
              {t("openInGitHub")}
            </a>
          </DropdownMenuItem>
          {pullRequest.state === "OPEN" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setMergeOpen(true)}>
                <GitMerge />
                {t("merge")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {pullRequest.state === "OPEN" && (
        <MergePullRequestButton
          onMerged={onMerged}
          onOpenChange={setMergeOpen}
          open={mergeOpen}
          pullRequest={pullRequest}
          showTrigger={false}
        />
      )}
    </>
  );
}

function GitHubRepositoryManager({
  open,
  setOpen,
  repositories,
  settings,
  onRepositoriesChanged,
  onSettingsChanged,
  tokenConfigured,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  repositories: GitHubRepositoryView[];
  settings: GitHubSettingsView | null;
  onRepositoriesChanged: (repositories: GitHubRepositoryView[]) => void;
  onSettingsChanged: (settings: GitHubSettingsView) => void;
  tokenConfigured: boolean;
}) {
  const t = useTranslations("pullRequests");
  const [available, setAvailable] = useState<GitHubRepositoryCandidate[]>([]);
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [repositorySearch, setRepositorySearch] = useState("");
  const [nameWithOwner, setNameWithOwner] = useState("");
  const [jiraKeyRegex, setJiraKeyRegex] = useState("");
  const [defaultJiraKeyRegex, setDefaultJiraKeyRegex] = useState(
    settings?.defaultJiraKeyRegex ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAvailable = useCallback(async (after: string | null) => {
    setBrowseLoading(true);
    try {
      const data = await controlPlaneRequest<{
        githubAvailableRepositories: GitHubRepositoryCandidatePage;
      }>(
        `query GitHubAvailableRepositories($after: String) {
          githubAvailableRepositories(after: $after) {
            items { githubId nameWithOwner url isPrivate managed }
            hasNextPage
            endCursor
          }
        }`,
        { after },
      );
      setAvailable((current) =>
        after
          ? [...current, ...data.githubAvailableRepositories.items]
          : data.githubAvailableRepositories.items,
      );
      setHasNextPage(data.githubAvailableRepositories.hasNextPage);
      setEndCursor(data.githubAvailableRepositories.endCursor);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !tokenConfigured || available.length > 0) return;
    const timeout = window.setTimeout(() => void loadAvailable(null), 0);
    return () => window.clearTimeout(timeout);
  }, [available.length, loadAvailable, open, tokenConfigured]);

  const addRepository = async (repositoryName: string, pattern: string) => {
    if (validateRegex(pattern)) {
      setError(t("invalidRegex"));
      return;
    }
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        addGitHubRepository: GitHubRepositoryView[];
      }>(
        `mutation AddGitHubRepository($input: AddGitHubRepositoryInput!) {
          addGitHubRepository(input: $input) { ${REPOSITORY_FIELDS} }
        }`,
        {
          input: {
            nameWithOwner: repositoryName,
            jiraKeyRegex: pattern || null,
          },
        },
      );
      onRepositoriesChanged(data.addGitHubRepository);
      setNameWithOwner("");
      setJiraKeyRegex("");
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    void addRepository(nameWithOwner, jiraKeyRegex);
  };

  const saveDefaultRegex = async () => {
    if (!defaultJiraKeyRegex.trim() || validateRegex(defaultJiraKeyRegex)) {
      setError(t("invalidRegex"));
      return;
    }
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveGitHubSettings: GitHubSettingsView;
      }>(
        `mutation SaveDefaultGitHubJiraKeyRegex(
          $input: SaveGitHubSettingsInput!
        ) {
          saveGitHubSettings(input: $input) {
            tokenConfigured defaultJiraKeyRegex updatedAt
          }
        }`,
        { input: { defaultJiraKeyRegex } },
      );
      onSettingsChanged(data.saveGitHubSettings);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const filteredAvailable = available.filter((candidate) =>
    candidate.nameWithOwner
      .toLowerCase()
      .includes(repositorySearch.trim().toLowerCase()),
  );

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("manageTitle")}</DialogTitle>
          <DialogDescription>{t("manageDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!tokenConfigured ? (
          <Alert>
            <AlertDescription>
              {t("manageCredentialsRequired")}{" "}
              <Link className="text-primary underline" href="/settings">
                {t("openSettings")}
              </Link>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="grid min-w-0 gap-6 md:grid-cols-2">
            <section className="min-w-0 space-y-3">
              <h3 className="font-medium">{t("managedRepositories")}</h3>
              <Item className="block space-y-2 p-3" variant="outline">
                <Label htmlFor="default-github-jira-regex">
                  {t("defaultJiraKeyRegex")}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="default-github-jira-regex"
                    onChange={(event) =>
                      setDefaultJiraKeyRegex(event.target.value)
                    }
                    value={defaultJiraKeyRegex}
                  />
                  <Button
                    aria-label={t("saveDefaultRegex")}
                    disabled={busy}
                    onClick={() => void saveDefaultRegex()}
                    size="icon"
                    type="button"
                  >
                    {busy ? <Spinner /> : <Save />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("defaultJiraKeyRegexHelp")}
                </p>
              </Item>
              {repositories.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("noManagedRepositories")}
                </p>
              ) : (
                <div className="space-y-3">
                  {repositories.map((repository) => (
                    <ManagedRepositoryEditor
                      key={repository.id}
                      busy={busy}
                      onBusyChange={setBusy}
                      onError={setError}
                      onRepositoriesChanged={onRepositoriesChanged}
                      repository={repository}
                    />
                  ))}
                </div>
              )}
            </section>
            <section className="min-w-0 space-y-3">
              <h3 className="font-medium">{t("addRepository")}</h3>
              <Tabs defaultValue="browse">
                <TabsList>
                  <TabsTrigger value="browse">{t("browse")}</TabsTrigger>
                  <TabsTrigger value="manual">{t("enterManually")}</TabsTrigger>
                </TabsList>
                <TabsContent className="mt-3 space-y-2" value="browse">
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      aria-label={t("searchAvailableRepositories")}
                      className="pl-8"
                      onChange={(event) =>
                        setRepositorySearch(event.target.value)
                      }
                      placeholder={t("searchAvailableRepositories")}
                      value={repositorySearch}
                    />
                  </div>
                  {filteredAvailable.map((candidate) => {
                    const managed = repositories.some(
                      (repository) =>
                        repository.githubId === candidate.githubId,
                    );
                    return (
                      <Item
                        key={candidate.githubId}
                        className="flex-nowrap p-2"
                        variant="outline"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {candidate.nameWithOwner}
                          </p>
                          {candidate.isPrivate && (
                            <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                              <LockKeyhole className="size-3" />
                              {t("privateRepository")}
                            </span>
                          )}
                        </div>
                        <Button
                          disabled={busy || managed}
                          onClick={() =>
                            void addRepository(candidate.nameWithOwner, "")
                          }
                          size="sm"
                        >
                          <Plus />
                          {managed ? t("managed") : t("add")}
                        </Button>
                      </Item>
                    );
                  })}
                  {!browseLoading && filteredAvailable.length === 0 && (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                      {t("noRepositoryMatches")}
                    </p>
                  )}
                  {browseLoading && (
                    <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                      <Spinner />
                      {t("loadingRepositories")}
                    </div>
                  )}
                  {hasNextPage && (
                    <Button
                      className="w-full"
                      disabled={browseLoading}
                      onClick={() => void loadAvailable(endCursor)}
                      variant="outline"
                    >
                      {t("loadMore")}
                    </Button>
                  )}
                </TabsContent>
                <TabsContent className="mt-3" value="manual">
                  <form className="space-y-4" onSubmit={submitManual}>
                    <div>
                      <Label
                        className="mb-1.5 block"
                        htmlFor="github-repository-name"
                      >
                        {t("repositoryName")}
                      </Label>
                      <Input
                        id="github-repository-name"
                        onChange={(event) =>
                          setNameWithOwner(event.target.value)
                        }
                        placeholder="owner/repository"
                        required
                        value={nameWithOwner}
                      />
                    </div>
                    <div>
                      <Label
                        className="mb-1.5 block"
                        htmlFor="github-repository-regex"
                      >
                        {t("jiraKeyRegex")}
                      </Label>
                      <Input
                        id="github-repository-regex"
                        onChange={(event) =>
                          setJiraKeyRegex(event.target.value)
                        }
                        value={jiraKeyRegex}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("jiraKeyRegexOverrideHelp")}
                      </p>
                    </div>
                    <Button disabled={busy} type="submit">
                      {busy ? <Spinner /> : <Plus />}
                      {t("addRepository")}
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>
            </section>
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManagedRepositoryEditor({
  repository,
  busy,
  onBusyChange,
  onError,
  onRepositoriesChanged,
}: {
  repository: GitHubRepositoryView;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onError: (error: string | null) => void;
  onRepositoriesChanged: (repositories: GitHubRepositoryView[]) => void;
}) {
  const t = useTranslations("pullRequests");
  const tc = useTranslations("common");
  const [pattern, setPattern] = useState(repository.jiraKeyRegex ?? "");

  const save = async () => {
    if (validateRegex(pattern)) {
      onError(t("invalidRegex"));
      return;
    }
    onBusyChange(true);
    try {
      const data = await controlPlaneRequest<{
        updateGitHubRepository: GitHubRepositoryView[];
      }>(
        `mutation UpdateGitHubRepository($input: UpdateGitHubRepositoryInput!) {
          updateGitHubRepository(input: $input) { ${REPOSITORY_FIELDS} }
        }`,
        { input: { id: repository.id, jiraKeyRegex: pattern || null } },
      );
      onRepositoriesChanged(data.updateGitHubRepository);
      onError(null);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      onBusyChange(false);
    }
  };

  const remove = async () => {
    onBusyChange(true);
    try {
      const data = await controlPlaneRequest<{
        removeGitHubRepository: GitHubRepositoryView[];
      }>(
        `mutation RemoveGitHubRepository($id: ID!) {
          removeGitHubRepository(id: $id) { ${REPOSITORY_FIELDS} }
        }`,
        { id: repository.id },
      );
      onRepositoriesChanged(data.removeGitHubRepository);
      onError(null);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      onBusyChange(false);
    }
  };

  return (
    <Item className="block space-y-3 p-3" variant="outline">
      <div className="flex items-start justify-between gap-2">
        <a
          className="min-w-0 truncate font-medium text-primary hover:underline"
          href={repository.url}
          rel="noreferrer"
          target="_blank"
        >
          {repository.nameWithOwner}
        </a>
        <ConfirmationDialog
          actionLabel={t("removeRepository")}
          cancelLabel={tc("cancel")}
          description={t("confirmRemoveRepositoryDescription")}
          onConfirm={remove}
          title={t("confirmRemoveRepository")}
          trigger={
            <Button disabled={busy} size="icon-sm" variant="ghost">
              <Trash2 />
              <span className="sr-only">{t("removeRepository")}</span>
            </Button>
          }
        />
      </div>
      <div>
        <Label
          className="mb-1.5 block text-xs"
          htmlFor={`github-regex-${repository.id}`}
        >
          {t("jiraKeyRegex")}
        </Label>
        <div className="flex gap-2">
          <Input
            id={`github-regex-${repository.id}`}
            onChange={(event) => setPattern(event.target.value)}
            value={pattern}
          />
          <Button disabled={busy} onClick={() => void save()} size="icon">
            {busy ? <Spinner /> : <Save />}
            <span className="sr-only">{t("saveRegex")}</span>
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("jiraKeyRegexOverrideHelp")}
        </p>
      </div>
    </Item>
  );
}
