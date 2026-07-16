"use client";

import {
  GitPullRequest,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { FormEvent, MouseEvent, useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { PipelineMenu } from "@/components/github/pipeline-menu";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import type {
  GitHubPipelineView,
  GitHubPullRequestPage,
  GitHubPullRequestScope,
  GitHubPullRequestView,
  GitHubRepositoryCandidate,
  GitHubRepositoryCandidatePage,
  GitHubRepositoryView,
  GitHubReviewDecision,
  GitHubSettingsView,
} from "@/services/github/types";

const DEFAULT_JIRA_KEY_REGEX = String.raw`\b([A-Z][A-Z0-9_]*-\d+)\b`;
const REPOSITORY_FIELDS =
  "id githubId owner name nameWithOwner url jiraKeyRegex";
const PULL_REQUEST_FIELDS =
  "id number title url repositoryGithubId repositoryNameWithOwner repositoryUrl labels jiraKey pipelineStatus pipelines { id name status url checkSuiteId canRetry retryUnavailableReason } reviewDecision unresolvedReviewThreadCount createdAt";

type TabKey = "mine" | "review" | `repo:${string}`;

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

function reviewClass(decision: GitHubReviewDecision) {
  if (decision === "APPROVED")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (decision === "CHANGES_REQUESTED")
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (decision === "REVIEW_REQUIRED")
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
}

function pullRequestDetailHref(pullRequest: GitHubPullRequestView) {
  const [owner, name] = pullRequest.repositoryNameWithOwner.split("/");
  return `/pull-requests/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${pullRequest.number}`;
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
  const [pages, setPages] = useState<
    Partial<Record<TabKey, GitHubPullRequestPage>>
  >({});
  const [loadingTabs, setLoadingTabs] = useState<
    Partial<Record<TabKey, boolean>>
  >({});
  const [configurationLoading, setConfigurationLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);

  const loadConfiguration = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        githubSettings: GitHubSettingsView;
        githubRepositories: GitHubRepositoryView[];
      }>(`query GitHubPullRequestConfiguration {
        githubSettings { tokenConfigured updatedAt }
        githubRepositories { ${REPOSITORY_FIELDS} }
      }`);
      setSettings(data.githubSettings);
      setRepositories(data.githubRepositories);
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

  const loadTab = useCallback(async (tab: TabKey) => {
    setLoadingTabs((current) => ({ ...current, [tab]: true }));
    try {
      const repositoryId = tab.startsWith("repo:") ? tab.slice(5) : null;
      const scope: GitHubPullRequestScope = repositoryId
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
        ) {
          githubPullRequests(scope: $scope, repositoryId: $repositoryId) {
            items { ${PULL_REQUEST_FIELDS} }
            truncated
          }
        }`,
        { scope, repositoryId },
      );
      setPages((current) => ({
        ...current,
        [tab]: data.githubPullRequests,
      }));
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoadingTabs((current) => ({ ...current, [tab]: false }));
    }
  }, []);

  useEffect(() => {
    if (
      settings?.tokenConfigured &&
      !pages[activeTab] &&
      !loadingTabs[activeTab]
    ) {
      const timeout = window.setTimeout(() => void loadTab(activeTab), 0);
      return () => window.clearTimeout(timeout);
    }
  }, [activeTab, loadTab, loadingTabs, pages, settings?.tokenConfigured]);

  useEffect(() => {
    if (
      activeTab.startsWith("repo:") &&
      !repositories.some((repository) => `repo:${repository.id}` === activeTab)
    ) {
      const timeout = window.setTimeout(() => setActiveTab("mine"), 0);
      return () => window.clearTimeout(timeout);
    }
  }, [activeTab, repositories]);

  const page = pages[activeTab];
  const loading = Boolean(loadingTabs[activeTab]);
  const repositorySpecific = activeTab.startsWith("repo:");

  const repositoriesChanged = (next: GitHubRepositoryView[]) => {
    setRepositories(next);
    setPages({});
  };

  const pipelineRetried = (
    pullRequestId: string,
    pipeline: GitHubPipelineView,
  ) => {
    setPages((current) => {
      const currentPage = current[activeTab];
      if (!currentPage) return current;
      return {
        ...current,
        [activeTab]: {
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
            onClick={() => void loadTab(activeTab)}
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
                {repositories.map((repository) => (
                  <TabsTrigger
                    key={repository.id}
                    value={`repo:${repository.id}`}
                  >
                    {repository.nameWithOwner}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {page?.truncated && (
            <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300">
              <AlertDescription className="text-current">
                {t("truncated")}
              </AlertDescription>
            </Alert>
          )}

          {loading && !page ? (
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
              onPipelineRetried={pipelineRetried}
              repositorySpecific={repositorySpecific}
            />
          ) : null}
        </>
      )}

      <GitHubRepositoryManager
        onRepositoriesChanged={repositoriesChanged}
        open={managerOpen}
        repositories={repositories}
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
  onPipelineRetried,
  repositorySpecific,
}: {
  items: GitHubPullRequestView[];
  locale: string;
  onPipelineRetried: (
    pullRequestId: string,
    pipeline: GitHubPipelineView,
  ) => void;
  repositorySpecific: boolean;
}) {
  const t = useTranslations("pullRequests");
  const router = useRouter();
  const stopRowClick = (event: MouseEvent) => event.stopPropagation();

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {!repositorySpecific && <TableHead>{t("repository")}</TableHead>}
            <TableHead>{t("number")}</TableHead>
            <TableHead>{t("pullRequest")}</TableHead>
            <TableHead>{t("labels")}</TableHead>
            <TableHead>{t("jira")}</TableHead>
            <TableHead>{t("pipeline")}</TableHead>
            <TableHead>{t("approval")}</TableHead>
            <TableHead>{t("openComments")}</TableHead>
            <TableHead>{t("age")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((pullRequest) => (
            <TableRow
              key={pullRequest.id}
              className="cursor-pointer"
              onClick={() => router.push(pullRequestDetailHref(pullRequest))}
            >
              {!repositorySpecific && (
                <TableCell className="whitespace-nowrap">
                  <a
                    className="text-primary hover:underline"
                    href={pullRequest.repositoryUrl}
                    onClick={stopRowClick}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {pullRequest.repositoryNameWithOwner}
                  </a>
                </TableCell>
              )}
              <TableCell>
                <Link
                  className="font-semibold text-primary hover:underline"
                  href={pullRequestDetailHref(pullRequest)}
                  onClick={stopRowClick}
                >
                  #{pullRequest.number}
                </Link>
              </TableCell>
              <TableCell className="min-w-72 whitespace-normal">
                <Link
                  className="font-medium hover:underline"
                  href={pullRequestDetailHref(pullRequest)}
                  onClick={stopRowClick}
                >
                  {pullRequest.title}
                </Link>
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
                  <Badge asChild className="cursor-pointer hover:bg-muted/80">
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
                  className={
                    pullRequest.unresolvedReviewThreadCount === 0
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  }
                >
                  {pullRequest.unresolvedReviewThreadCount}
                </Badge>
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                <time dateTime={pullRequest.createdAt}>
                  {relativeAge(pullRequest.createdAt, locale)}
                </time>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function GitHubRepositoryManager({
  open,
  setOpen,
  repositories,
  onRepositoriesChanged,
  tokenConfigured,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  repositories: GitHubRepositoryView[];
  onRepositoriesChanged: (repositories: GitHubRepositoryView[]) => void;
  tokenConfigured: boolean;
}) {
  const t = useTranslations("pullRequests");
  const [available, setAvailable] = useState<GitHubRepositoryCandidate[]>([]);
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [nameWithOwner, setNameWithOwner] = useState("");
  const [jiraKeyRegex, setJiraKeyRegex] = useState(DEFAULT_JIRA_KEY_REGEX);
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
      setJiraKeyRegex(DEFAULT_JIRA_KEY_REGEX);
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
                  {available.map((candidate) => {
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
                            void addRepository(
                              candidate.nameWithOwner,
                              DEFAULT_JIRA_KEY_REGEX,
                            )
                          }
                          size="sm"
                        >
                          <Plus />
                          {managed ? t("managed") : t("add")}
                        </Button>
                      </Item>
                    );
                  })}
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
                        {t("jiraKeyRegexHelp")}
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
      </div>
    </Item>
  );
}
