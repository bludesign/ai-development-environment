"use client";

import { useBreadcrumbLabel } from "@/components/breadcrumb-labels-provider";

import {
  readIntegrationConfiguration,
  subscribeIntegrationConfiguration,
} from "@/lib/integration-configuration";
import {
  CheckCircle2,
  GitBranch,
  ExternalLink,
  GitMerge,
  GitFork,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  Webhook,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MergeRequestDialog } from "./merge-request-dialog";
import { GitLabProjectManagerDialog } from "./project-manager-dialog";
import { GITLAB_MERGE_REQUEST_FIELDS } from "./merge-request-fields";
import { GitLabMergeRequestTable } from "./merge-request-table";
import {
  GitLabApprovalBadge,
  GitLabMergeReadinessBadge,
  GitLabMergeRequestStateBadge,
  gitLabStatusColors,
} from "./merge-request-status";
import { GitLabMarkdown } from "./markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateTime } from "@/components/common/date-time";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  GitLabAccessibleProjectSelect,
  type GitLabProjectOption,
} from "./accessible-project-select";
import { Textarea } from "@/components/ui/textarea";
import { worktreeDetailHref } from "@/components/worktrees/worktree-navigation";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";
import { cn } from "@/lib/utils";
import { worktreeHighlightBackgroundClasses } from "@/lib/worktree-highlight";
import type {
  GitLabApiCallView,
  GitLabAutoRetryRuleView,
  GitLabCacheEntryView,
  GitLabDiscussionView,
  GitLabMergeRequestDetailView,
  GitLabMergeRequestScope,
  GitLabMergeRequestView,
  GitLabPipelineView,
  GitLabProjectView,
  GitLabSettingsView,
  GitLabWebhookDeliveryView,
  GitLabUserView,
  Paginated,
} from "@/services/gitlab";

import {
  gitLabPipelineSources,
  gitLabPipelineStatuses,
  isActiveGitLabPipeline,
} from "./pipeline-format";
import { GitLabPipelinesTable } from "./pipelines-table";

const SETTINGS =
  "configured baseUrl version tokenConfigured pipelinePollIntervalSeconds memberProjectsOnly defaultSquash defaultMoveTicketToDone defaultDeleteWorktree";
const PROJECT =
  "id name pathWithNamespace webUrl defaultBranch visibility enabled webhookId webhookState webhookError webhookConfiguredAt webhookLastReceivedAt";
const USER = "id username name avatarUrl webUrl";
const PIPELINE =
  "id projectId iid ref branch sha source status webUrl mergeRequests { projectId iid title webUrl sourceBranch } worktreeId worktreeHighlightColor startedAt createdAt updatedAt finishedAt duration queuedDuration";
const MR = GITLAB_MERGE_REQUEST_FIELDS;
const DISCUSSION = `id individualNote notes {
  id body author { ${USER} } createdAt updatedAt system resolvable resolved resolvedBy { ${USER} }
}`;

type Configuration = {
  settings: GitLabSettingsView;
  projects: GitLabProjectView[];
};

type GitLabPagination = Pick<
  Paginated<unknown>,
  "total" | "page" | "perPage" | "nextPage"
>;

const ALL_PROJECTS_VALUE = "__all_projects__";

function ProviderNotConfigured() {
  const t = useTranslations("gitlabPages");
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3 py-8">
        <GitFork className="size-8 text-muted-foreground" />
        <div>
          <h2 className="font-semibold">{t("notConfigured")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("notConfiguredDescription")}
          </p>
        </div>
        <Button asChild>
          <Link href="/system/settings#settings-integrations">
            {t("openSettings")}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function ErrorAlert({ error }: { error: string | null }) {
  return error ? (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;
}

function PageHeader({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function PaginationControls({
  busy,
  onPageChange,
  pagination,
}: {
  busy: boolean;
  onPageChange: (page: number) => void;
  pagination: GitLabPagination | null;
}) {
  const t = useTranslations("gitlabPages");
  if (!pagination || (pagination.page === 1 && pagination.nextPage === null)) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">
        {t("pageSummary", {
          page: pagination.page,
          total: pagination.total,
        })}
      </span>
      <div className="flex gap-2">
        <Button
          disabled={busy || pagination.page <= 1}
          onClick={() => onPageChange(pagination.page - 1)}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("previous")}
        </Button>
        <Button
          disabled={busy || pagination.nextPage === null}
          onClick={() => {
            if (pagination.nextPage !== null) {
              onPageChange(pagination.nextPage);
            }
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("next")}
        </Button>
      </div>
    </div>
  );
}

function ProjectSelect({
  projects,
  value,
  onChange,
  allowAll = false,
}: {
  projects: GitLabProjectView[];
  value: string;
  onChange: (value: string) => void;
  allowAll?: boolean;
}) {
  const t = useTranslations("gitlabPages");
  return (
    <Select
      onValueChange={(nextValue) =>
        onChange(nextValue === ALL_PROJECTS_VALUE ? "" : nextValue)
      }
      value={allowAll && !value ? ALL_PROJECTS_VALUE : value}
    >
      <SelectTrigger aria-label={t("project")} className="h-9 min-w-56">
        <SelectValue placeholder={t("chooseProject")} />
      </SelectTrigger>
      <SelectContent>
        {allowAll && (
          <SelectItem value={ALL_PROJECTS_VALUE}>{t("allProjects")}</SelectItem>
        )}
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.pathWithNamespace}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function useConfiguration(): {
  configuration: Configuration | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [configuration, setConfiguration] = useState<Configuration | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const data = await readIntegrationConfiguration<{
        gitlabSettings: GitLabSettingsView;
        gitlabProjects: GitLabProjectView[];
      }>(
        "gitlab",
        `query GitLabPageConfiguration {
        gitlabSettings { ${SETTINGS} }
        gitlabProjects { ${PROJECT} }
      }`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setConfiguration({
        settings: data.gitlabSettings,
        projects: data.gitlabProjects,
      });
      setError(null);
    } catch (value) {
      if (controller.signal.aborted) return;
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timeout = window.setTimeout(() => void reload(), 0);
    const dispose = subscribeIntegrationConfiguration(
      "gitlab",
      () => void reload(),
    );
    return () => {
      window.clearTimeout(timeout);
      dispose();
      controllerRef.current?.abort();
    };
  }, [reload]);
  return { configuration, loading, error, reload };
}

type MergeRequestFilters = {
  scope: Exclude<GitLabMergeRequestScope, "PROJECT">;
  projectId: string;
  state: "OPENED" | "MERGED" | "CLOSED" | "ALL";
  page: number;
};

function mergeRequestFiltersFromUrl(search: string): MergeRequestFilters {
  const params = new URLSearchParams(search);
  const scope = params.get("scope");
  const state = params.get("state");
  const page = Number(params.get("page"));
  return {
    scope:
      scope === "ALL" || scope === "PROJECT"
        ? "ALL"
        : scope === "REVIEW_REQUESTED"
          ? scope
          : "MINE",
    projectId: params.get("project") ?? "",
    state:
      state === "MERGED" || state === "CLOSED" || state === "ALL"
        ? state
        : "OPENED",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

function observedMergeRequestProject(
  mr: GitLabMergeRequestView,
): GitLabProjectOption {
  let path = mr.projectPath;
  if (!path) {
    try {
      path = new URL(mr.webUrl).pathname
        .split("/-/merge_requests/")[0]
        ?.replace(/^\//, "");
    } catch {
      /* The provider ID remains a usable fallback. */
    }
  }
  return { id: mr.projectId, pathWithNamespace: path || mr.projectId };
}

export function GitLabMergeRequestsPage({
  initialSearch,
}: { initialSearch?: string } = {}) {
  const t = useTranslations("gitlabPages");
  const {
    configuration,
    loading,
    error: configurationError,
    reload: reloadConfiguration,
  } = useConfiguration();
  const [ticketKey, setTicketKey] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<GitLabMergeRequestView | null>(
    null,
  );
  const [items, setItems] = useState<GitLabMergeRequestView[]>([]);
  const [observedProjects, setObservedProjects] = useState<
    GitLabProjectOption[]
  >([]);
  const [filters, setFilters] = useState<MergeRequestFilters>({
    scope: "MINE",
    projectId: "",
    state: "OPENED",
    page: 1,
  });
  const [restored, setRestored] = useState(false);
  const [pagination, setPagination] = useState<GitLabPagination | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const { scope, projectId, state, page } = filters;
  const requiresProject = scope === "ALL" && !projectId;

  useEffect(() => {
    const restore = (search: string) => {
      controllerRef.current?.abort();
      const next = mergeRequestFiltersFromUrl(search);
      setFilters(next);
      setItems([]);
      setPagination(null);
      setError(null);
      setBusy(!(next.scope === "ALL" && !next.projectId));
      setRestored(true);
    };
    const restoreHistory = () => restore(window.location.search);
    const timer = window.setTimeout(
      () => restore(initialSearch ?? window.location.search),
      0,
    );
    window.addEventListener("popstate", restoreHistory);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", restoreHistory);
      controllerRef.current?.abort();
    };
  }, [initialSearch]);

  const changeFilters = (changes: Partial<MergeRequestFilters>) => {
    controllerRef.current?.abort();
    const next = { ...filters, page: 1, ...changes };
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries({
      scope: next.scope === "MINE" ? "" : next.scope,
      project: next.projectId,
      state: next.state === "OPENED" ? "" : next.state,
      page: next.page > 1 ? String(next.page) : "",
    })) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    setFilters(next);
    setItems([]);
    setPagination(null);
    setError(null);
    setBusy(!(next.scope === "ALL" && !next.projectId));
  };

  const load = useCallback(async () => {
    if (
      !configuration?.settings.configured ||
      !restored ||
      (scope === "ALL" && !projectId)
    )
      return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        gitlabMergeRequests: Paginated<GitLabMergeRequestView>;
      }>(
        `query GitLabMergeRequests($scope: GitLabMergeRequestScope!, $projectId: ID, $state: GitLabMergeRequestState!, $page: Int!) {
          gitlabMergeRequests(scope: $scope, projectId: $projectId, state: $state, page: $page) {
            total page perPage nextPage items { ${MR} }
          }
        }`,
        { scope, projectId: projectId || null, state, page },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setItems(data.gitlabMergeRequests.items);
      setPagination(data.gitlabMergeRequests);
      setObservedProjects((previous) => [
        ...new Map(
          [
            ...previous,
            ...data.gitlabMergeRequests.items.map(observedMergeRequestProject),
          ].map((project) => [project.id, project]),
        ).values(),
      ]);
    } catch (value) {
      if (controller.signal.aborted) return;
      setItems([]);
      setPagination(null);
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [
    configuration?.settings.configured,
    restored,
    page,
    projectId,
    scope,
    state,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
  }, [load]);

  if (loading || !restored) return <Spinner />;
  if (!configuration?.settings.configured) return <ProviderNotConfigured />;
  const timedOut =
    error && (/\(408\)/.test(error) || /timed? out/i.test(error));
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          description={t("mergeRequestsDescription")}
          title={t("mergeRequestsPageTitle")}
        />
        <GitLabProjectManagerDialog
          onChanged={reloadConfiguration}
          projects={configuration.projects}
          settings={configuration.settings}
        />
      </div>
      <ErrorAlert error={configurationError} />
      <div className="overflow-x-auto pb-1">
        <Tabs
          value={scope}
          onValueChange={(value) =>
            changeFilters({ scope: value as MergeRequestFilters["scope"] })
          }
        >
          <TabsList aria-label={t("scope")}>
            <TabsTrigger value="MINE">{t("mine")}</TabsTrigger>
            <TabsTrigger value="REVIEW_REQUESTED">
              {t("reviewRequests")}
            </TabsTrigger>
            <TabsTrigger value="ALL">{t("allAccessible")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <GitLabAccessibleProjectSelect
            allowAll={scope !== "ALL"}
            value={projectId}
            onChange={(value) => changeFilters({ projectId: value })}
            knownProjects={[...configuration.projects, ...observedProjects]}
          />
          <Select
            value={state}
            onValueChange={(value) =>
              changeFilters({ state: value as MergeRequestFilters["state"] })
            }
          >
            <SelectTrigger
              aria-label={t("status")}
              className="min-w-36 data-[size=default]:h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="OPENED">{t("open")}</SelectItem>
              <SelectItem value="MERGED">{t("merged")}</SelectItem>
              <SelectItem value="CLOSED">{t("closed")}</SelectItem>
              <SelectItem value="ALL">{t("all")}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            disabled={busy || requiresProject}
            onClick={() => void load()}
            size="lg"
            type="button"
            variant="outline"
          >
            {busy ? <Spinner /> : <RefreshCw />}
            {t("refresh")}
          </Button>
        </div>
        {scope === "MINE" && (
          <p className="text-sm text-muted-foreground">
            {t("mineDescription")}
          </p>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{timedOut ? t("mergeRequestsTimedOut") : error}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void load()}
            >
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {requiresProject ? (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            {t("allAccessibleChooseProject")}
          </CardContent>
        </Card>
      ) : busy && items.length === 0 ? (
        <div
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner />
          {t("loadingMergeRequests")}
        </div>
      ) : items.length === 0 && !error ? (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            {t("noMergeRequests")}
          </CardContent>
        </Card>
      ) : items.length > 0 ? (
        <GitLabMergeRequestTable
          items={items}
          projects={configuration.projects}
          onMerge={setMergeTarget}
          onTicket={setTicketKey}
        />
      ) : null}
      {!requiresProject && (
        <PaginationControls
          busy={busy}
          onPageChange={(value) => changeFilters({ page: value })}
          pagination={pagination}
        />
      )}
      {mergeTarget && (
        <MergeRequestDialog
          mergeRequest={mergeTarget}
          worktreeId={mergeTarget.worktreeId}
          open
          onOpenChange={(open) => {
            if (!open) setMergeTarget(null);
          }}
          onMerged={load}
        />
      )}
      <JiraTicketDrawer
        issueKey={ticketKey}
        onClose={() => setTicketKey(null)}
      />
    </section>
  );
}

export function GitLabMergeRequestDetailPage({
  projectId,
  iid,
}: {
  projectId: string;
  iid: number;
}) {
  const t = useTranslations("gitlabPages");
  const {
    configuration,
    loading: configurationLoading,
    error: configurationError,
  } = useConfiguration();
  const [mr, setMr] = useState<GitLabMergeRequestDetailView | null>(null);
  const loadedProjectId =
    mr && (projectId === mr.projectId || projectId === mr.projectPath)
      ? projectId
      : undefined;
  const projectPath =
    mr?.projectPath ??
    configuration?.projects.find((project) => project.id === mr?.projectId)
      ?.pathWithNamespace ??
    mr?.projectId;
  useBreadcrumbLabel(
    ["gitlab", "merge-requests", loadedProjectId],
    projectPath,
  );
  useBreadcrumbLabel(
    ["gitlab", "merge-requests", loadedProjectId, mr?.iid],
    mr?.title,
  );
  const [reviewBody, setReviewBody] = useState("");
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [ticketKey, setTicketKey] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!configuration?.settings.configured) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        gitlabMergeRequest: GitLabMergeRequestDetailView;
      }>(
        `query GitLabMergeRequest($projectId: ID!, $iid: Int!) {
          gitlabMergeRequest(projectId: $projectId, iid: $iid) { ${MR} changesCount commitsCount discussions { ${DISCUSSION} } pipelines { ${PIPELINE} } }
        }`,
        { projectId, iid },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setMr(data.gitlabMergeRequest);
      setError(null);
    } catch (value) {
      if (!controller.signal.aborted)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [configuration?.settings.configured, iid, projectId]);

  useEffect(() => {
    if (!configuration?.settings.configured) return;
    const timer = window.setTimeout(() => void load(), 0);
    const dispose = subscribeIntegrationConfiguration(
      "gitlab",
      () => void load(),
    );
    const recover = onControlPlaneRecovery(() => void load());
    return () => {
      window.clearTimeout(timer);
      dispose();
      recover();
      controllerRef.current?.abort();
    };
  }, [configuration?.settings.configured, load]);
  useEffect(() => {
    if (
      !mr?.mergeWhenPipelineSucceeds &&
      !["PREPARING", "WAITING", "POST_MERGE"].includes(
        mr?.mergeOperation?.state ?? "",
      )
    )
      return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load, mr?.mergeWhenPipelineSucceeds, mr?.mergeOperation?.state]);

  const review = async (outcome: "APPROVE" | "COMMENT" | "REQUEST_CHANGES") => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation SubmitGitLabReview($input: SubmitGitLabReviewInput!) { submitGitLabReview(input: $input) }`,
        { input: { projectId, iid, outcome, body: reviewBody.trim() || null } },
      );
      setReviewBody("");
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };
  const reply = async (discussionId: string) => {
    const body = replyBodies[discussionId]?.trim();
    if (!body) return;
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation ReplyToGitLabDiscussion($input: GitLabDiscussionInput!, $body: String!) { replyToGitLabDiscussion(input: $input, body: $body) { id } }`,
        { input: { projectId, iid, discussionId }, body },
      );
      setReplyBodies((items) => ({ ...items, [discussionId]: "" }));
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };
  const resolve = async (
    discussion: GitLabDiscussionView,
    resolved: boolean,
  ) => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation ResolveGitLabDiscussion($input: GitLabDiscussionInput!, $resolved: Boolean!) { setGitLabDiscussionResolved(input: $input, resolved: $resolved) { id } }`,
        { input: { projectId, iid, discussionId: discussion.id }, resolved },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };

  if (configurationLoading) return <Spinner />;
  if (!configuration?.settings.configured) return <ProviderNotConfigured />;
  if (!mr && busy) return <Spinner />;
  if (!mr)
    return (
      <section className="space-y-4">
        <ErrorAlert error={configurationError ?? error} />
        <p className="text-muted-foreground">{t("noMergeRequest")}</p>
        <Button asChild variant="outline">
          <Link href="/gitlab/merge-requests">{t("backToMergeRequests")}</Link>
        </Button>
      </section>
    );
  const highlighted = mr.worktreeHighlightColor;
  return (
    <section className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-5">
      <ErrorAlert error={configurationError ?? error} />
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-4",
          highlighted && "rounded-lg border-l-4 p-4",
          highlighted && worktreeHighlightBackgroundClasses[highlighted],
        )}
      >
        <div className="min-w-0">
          <Link
            className="text-sm text-muted-foreground hover:underline"
            href="/gitlab/merge-requests"
          >
            {t("backToMergeRequests")}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold break-words tracking-tight [overflow-wrap:anywhere]">
            {mr.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {projectPath} !{mr.iid}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <GitLabMergeRequestStateBadge state={mr.state} draft={mr.draft} />
            {mr.draft && <Badge variant="secondary">{t("draft")}</Badge>}
            <GitLabApprovalBadge state={mr.approvalState} />
            <GitLabMergeReadinessBadge
              state={mr.state}
              status={mr.detailedMergeStatus}
              hasConflicts={mr.hasConflicts}
            />
            {mr.mergeWhenPipelineSucceeds && mr.state === "OPENED" && (
              <Badge className={gitLabStatusColors.warning}>
                {t("autoMergeEnabled")}
              </Badge>
            )}
            {mr.ticketKey && (
              <Badge asChild>
                <button
                  type="button"
                  onClick={() => setTicketKey(mr.ticketKey!)}
                >
                  {mr.ticketKey}
                </button>
              </Badge>
            )}
            {mr.labels.map((label) => (
              <Badge key={label} variant="secondary">
                {label}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {mr.worktreeId && (
            <Button asChild variant="outline">
              <Link href={worktreeDetailHref(mr.worktreeId)}>
                <GitBranch />
                {t("viewWorktree")}
              </Link>
            </Button>
          )}
          {(mr.state === "OPENED" || mr.mergeOperation) && (
            <Button onClick={() => setMergeOpen(true)} variant="outline">
              <GitMerge />
              {t(mr.state === "MERGED" ? "mergeFollowUps" : "mergeOptions")}
            </Button>
          )}
          <Button disabled={busy} onClick={() => void load()} variant="outline">
            <RefreshCw className={busy ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
          <Button asChild>
            <a href={mr.webUrl} rel="noreferrer" target="_blank">
              {t("openInGitLab")}
              <ExternalLink />
            </a>
          </Button>
        </div>
      </div>
      {mr.mergeOperation?.lastError && (
        <Alert variant="destructive">
          <AlertDescription>{mr.mergeOperation.lastError}</AlertDescription>
        </Alert>
      )}
      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t("details")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <GitLabDetailRow label={t("branches")}>
                <span className="font-mono text-xs">
                  {mr.sourceBranch} → {mr.targetBranch}
                </span>
              </GitLabDetailRow>
              <GitLabDetailRow label={t("commit")}>
                <span className="font-mono text-xs">{mr.sha.slice(0, 12)}</span>
              </GitLabDetailRow>
              <GitLabDetailRow label={t("changedFiles")}>
                {mr.changesCount ?? "—"}
              </GitLabDetailRow>
              <GitLabDetailRow label={t("commitCount")}>
                {mr.commitsCount}
              </GitLabDetailRow>
              <GitLabDetailRow label={t("openDiscussions")}>
                {mr.unresolvedDiscussionsCount ?? t("unavailable")}
              </GitLabDetailRow>
              <GitLabDetailRow label={t("created")}>
                <DateTime value={mr.createdAt} />
              </GitLabDetailRow>
              <GitLabDetailRow label={t("updated")}>
                <DateTime value={mr.updatedAt} />
              </GitLabDetailRow>
              {mr.mergedAt && (
                <GitLabDetailRow label={t("mergedAt")}>
                  <DateTime value={mr.mergedAt} />
                </GitLabDetailRow>
              )}
            </dl>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t("people")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="mb-2 text-xs text-muted-foreground">
                {t("author")}
              </p>
              <GitLabPerson user={mr.author} />
            </div>
            <div>
              <p className="mb-2 text-xs text-muted-foreground">
                {t("reviewers")}
              </p>
              {mr.reviewers.length ? (
                <div className="space-y-2">
                  {mr.reviewers.map((user) => (
                    <GitLabPerson key={user.id} user={user} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("noReviewers")}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t("description")}</CardTitle>
        </CardHeader>
        <CardContent>
          <GitLabMarkdown
            body={mr.description}
            emptyLabel={t("noDescription")}
            actions
          />
        </CardContent>
      </Card>
      <Card className="min-w-0 gap-0 py-0" id="pipelines">
        <CardHeader>
          <CardTitle>{t("pipelines")}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <GitLabPipelinesTable
            pipelines={mr.pipelines}
            pollIntervalSeconds={
              configuration.settings.pipelinePollIntervalSeconds
            }
            onChanged={load}
            showMergeRequests={false}
          />
        </CardContent>
      </Card>
      <div id="discussions" className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{t("discussions")}</h2>
          <Badge variant="secondary">{mr.discussions.length}</Badge>
        </div>
        {mr.discussions.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              {t("noDiscussions")}
            </CardContent>
          </Card>
        ) : (
          mr.discussions.map((discussion) => {
            const resolvableNotes = discussion.notes.filter(
              (note) => note.resolvable,
            );
            const resolved =
              resolvableNotes.length > 0 &&
              resolvableNotes.every((note) => note.resolved);
            return (
              <Card key={discussion.id} className="min-w-0">
                <CardContent className="space-y-4">
                  {resolvableNotes.length > 0 && (
                    <Badge
                      className={
                        resolved
                          ? gitLabStatusColors.success
                          : gitLabStatusColors.warning
                      }
                    >
                      {t(resolved ? "resolved" : "unresolved")}
                    </Badge>
                  )}
                  {discussion.notes.map((note) => (
                    <div key={note.id} className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <GitLabPerson user={note.author} />
                        <span className="text-xs text-muted-foreground">
                          <DateTime value={note.createdAt} />
                        </span>
                      </div>
                      <GitLabMarkdown body={note.body} />
                    </div>
                  ))}
                  <Textarea
                    aria-label={t("reply")}
                    placeholder={t("reply")}
                    value={replyBodies[discussion.id] ?? ""}
                    onChange={(event) =>
                      setReplyBodies((items) => ({
                        ...items,
                        [discussion.id]: event.target.value,
                      }))
                    }
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={
                        busy || !(replyBodies[discussion.id] ?? "").trim()
                      }
                      onClick={() => void reply(discussion.id)}
                    >
                      {t("reply")}
                    </Button>
                    {resolvableNotes.length > 0 && (
                      <Button
                        size="sm"
                        disabled={busy}
                        variant="outline"
                        onClick={() => void resolve(discussion, !resolved)}
                      >
                        {t(resolved ? "reopen" : "resolve")}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
      {mr.state === "OPENED" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("review")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              aria-label={t("reviewSummary")}
              placeholder={t("reviewSummary")}
              value={reviewBody}
              onChange={(event) => setReviewBody(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void review("APPROVE")}>
                <CheckCircle2 />
                {t("approve")}
              </Button>
              <Button
                disabled={busy}
                variant="outline"
                onClick={() => void review("COMMENT")}
              >
                {t("comment")}
              </Button>
              <Button
                disabled={busy}
                variant="outline"
                onClick={() => void review("REQUEST_CHANGES")}
              >
                {t("requestChanges")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <MergeRequestDialog
        mergeRequest={mr}
        worktreeId={mr.worktreeId}
        onMerged={async () => {
          await load();
        }}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
      />
      <JiraTicketDrawer
        issueKey={ticketKey}
        onClose={() => setTicketKey(null)}
      />
    </section>
  );
}

function GitLabDetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

function GitLabPerson({ user }: { user: GitLabUserView }) {
  return (
    <a
      className="inline-flex items-center gap-2 text-sm hover:underline"
      href={user.webUrl}
      rel="noreferrer"
      target="_blank"
    >
      <Avatar size="sm">
        <AvatarImage alt="" src={user.avatarUrl ?? undefined} />
        <AvatarFallback>
          {user.username.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      @{user.username}
    </a>
  );
}

export function GitLabPipelinesPage() {
  const t = useTranslations("gitlabPages");
  const {
    configuration,
    loading,
    error: configurationError,
  } = useConfiguration();
  const [projectId, setProjectId] = useState("");
  const [pipelines, setPipelines] = useState<GitLabPipelineView[]>([]);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<GitLabPagination | null>(null);
  const [branch, setBranch] = useState("");
  const [branchInput, setBranchInput] = useState("");
  const [status, setStatus] = useState("all");
  const [source, setSource] = useState("all");
  const [ref, setRef] = useState("");
  const [autoRetryRules, setAutoRetryRules] = useState<
    GitLabAutoRetryRuleView[]
  >([]);
  const [maxAttempts, setMaxAttempts] = useState("1");
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const actionInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const currentScope = `${projectId}:${page}:${branch}:${status}:${source}`;
  const scopeRef = useRef(currentScope);
  useEffect(() => {
    scopeRef.current = currentScope;
  }, [currentScope]);

  useEffect(() => {
    const projects = configuration?.projects;
    if (!projects?.length) return;
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      const project =
        projects.find((item) => item.id === params.get("project")) ??
        projects[0];
      setProjectId(project.id);
      setRef(project.defaultBranch ?? "main");
      setBranch(params.get("branch")?.trim() ?? "");
      setBranchInput(params.get("branch")?.trim() ?? "");
      setStatus(
        gitLabPipelineStatuses.find(
          (value) => value === params.get("status"),
        ) ?? "all",
      );
      setSource(
        gitLabPipelineSources.find((value) => value === params.get("source")) ??
          "all",
      );
      const requestedPage = Number(params.get("page"));
      setPage(
        Number.isSafeInteger(requestedPage) && requestedPage > 0
          ? requestedPage
          : 1,
      );
    };
    const initial = window.setTimeout(restore, 0);
    window.addEventListener("popstate", restore);
    return () => {
      window.clearTimeout(initial);
      window.removeEventListener("popstate", restore);
    };
  }, [configuration?.projects]);

  useEffect(() => {
    if (!projectId) return;
    const params = new URLSearchParams(window.location.search);
    params.set("project", projectId);
    if (branch) params.set("branch", branch);
    else params.delete("branch");
    if (status !== "all") params.set("status", status);
    else params.delete("status");
    if (source !== "all") params.set("source", source);
    else params.delete("source");
    if (page > 1) params.set("page", String(page));
    else params.delete("page");
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${params.toString()}`,
    );
  }, [branch, page, projectId, source, status]);

  const loadController = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!projectId) return;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        gitlabPipelines: Paginated<GitLabPipelineView>;
        gitlabAutoRetryRules: GitLabAutoRetryRuleView[];
      }>(
        `query GitLabPipelines($projectId: ID!, $page: Int!, $ref: String, $status: GitLabPipelineStatus, $source: String) {
        gitlabPipelines(projectId: $projectId, page: $page, ref: $ref, status: $status, source: $source) { total page perPage nextPage items { ${PIPELINE} } }
        gitlabAutoRetryRules(projectId: $projectId) { id projectId pipelineId enabled maxAttempts attempts lastError lastAttemptAt createdAt updatedAt executions { id pipelineId attempt status lastError createdAt updatedAt } }
      }`,
        {
          projectId,
          page,
          ref: branch || null,
          status: status === "all" ? null : status,
          source: source === "all" ? null : source,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setPipelines(data.gitlabPipelines.items);
      setPagination(data.gitlabPipelines);
      setAutoRetryRules(data.gitlabAutoRetryRules);
      setError(null);
    } catch (value) {
      if (!controller.signal.aborted)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [branch, page, projectId, source, status]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timeout);
      loadController.current?.abort();
    };
  }, [load]);

  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
  }, [load]);
  useEffect(() => {
    if (!projectId) return;
    const refresh = createRefreshCoalescer(() => latestLoad.current());
    const requestRefresh = () => {
      if (document.visibilityState !== "hidden")
        void refresh.refresh().catch(() => undefined);
    };
    const off = controlPlaneSubscriptions().subscribe<{
      gitlabPipelineStatusChanged: { projectId: string };
    }>(
      {
        query:
          "subscription GitLabPipelineRulesChanged { gitlabPipelineStatusChanged { projectId } }",
      },
      {
        next: ({ data }) => {
          if (data?.gitlabPipelineStatusChanged.projectId === projectId)
            requestRefresh();
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const recover = onControlPlaneRecovery(requestRefresh);
    document.addEventListener("visibilitychange", requestRefresh);
    return () => {
      off();
      recover();
      refresh.dispose();
      document.removeEventListener("visibilitychange", requestRefresh);
    };
  }, [projectId]);

  const active = pipelines.some((pipeline) =>
    isActiveGitLabPipeline(pipeline.status),
  );
  useEffect(() => {
    if (!projectId || !active) return;
    const timer = window.setInterval(
      () => {
        if (document.visibilityState !== "hidden") void latestLoad.current();
      },
      Math.max(30, configuration?.settings.pipelinePollIntervalSeconds ?? 60) *
        1_000,
    );
    return () => window.clearInterval(timer);
  }, [active, projectId, configuration?.settings.pipelinePollIntervalSeconds]);

  const perform = async (request: () => Promise<unknown>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActionBusy(true);
    const scope = currentScope;
    try {
      await request();
      if (scopeRef.current === scope) await load();
    } catch (value) {
      if (scopeRef.current === scope)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      actionInFlight.current = false;
      setActionBusy(false);
    }
  };

  const create = () => {
    if (!projectId || !ref.trim()) return;
    void perform(() =>
      controlPlaneRequest(
        "mutation CreateGitLabPipeline($projectId: ID!, $ref: String!) { createGitLabPipeline(projectId: $projectId, ref: $ref) { id } }",
        { projectId, ref: ref.trim() },
      ),
    );
  };
  const saveAutoRetry = () => {
    const attempts = Number(maxAttempts);
    if (
      !projectId ||
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      attempts > 100
    )
      return;
    void perform(() =>
      controlPlaneRequest(
        "mutation SaveGitLabAutoRetryRule($input: SaveGitLabAutoRetryRuleInput!) { saveGitLabAutoRetryRule(input: $input) { id } }",
        { input: { projectId, maxAttempts: attempts, enabled: true } },
      ),
    );
  };
  const deleteAutoRetry = (id: string) => {
    void perform(() =>
      controlPlaneRequest(
        "mutation DeleteGitLabAutoRetryRule($id: ID!) { deleteGitLabAutoRetryRule(id: $id) }",
        { id },
      ),
    );
  };

  if (loading) return <Spinner />;
  if (!configuration?.settings.configured) return <ProviderNotConfigured />;
  return (
    <section className="space-y-6">
      <PageHeader
        description={t("pipelinesDescription")}
        title={t("pipelinesPageTitle")}
      />
      <ErrorAlert error={configurationError ?? error} />
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap gap-3">
            <ProjectSelect
              onChange={(value) => {
                setPage(1);
                setProjectId(value);
                setPipelines([]);
                setPagination(null);
                setAutoRetryRules([]);
                setBranch("");
                setBranchInput("");
                setRef(
                  configuration.projects.find((item) => item.id === value)
                    ?.defaultBranch ?? "main",
                );
              }}
              projects={configuration.projects}
              value={projectId}
            />
            <Input
              aria-label={t("filterBranch")}
              className="max-w-64"
              onChange={(event) => setBranchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setBranch(branchInput.trim());
                  setPage(1);
                }
              }}
              placeholder={t("filterBranch")}
              value={branchInput}
            />
            <Button
              disabled={!projectId}
              onClick={() => {
                setBranch(branchInput.trim());
                setPage(1);
              }}
              variant="outline"
            >
              {t("applyFilters")}
            </Button>
            <Select
              onValueChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              value={status}
            >
              <SelectTrigger aria-label={t("status")} className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allStatuses")}</SelectItem>
                {gitLabPipelineStatuses.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`pipelineStatuses.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              onValueChange={(value) => {
                setSource(value);
                setPage(1);
              }}
              value={source}
            >
              <SelectTrigger aria-label={t("source")} className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allSources")}</SelectItem>
                {gitLabPipelineSources.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`pipelineSources.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={busy || !projectId}
              onClick={() => void load()}
              variant="outline"
            >
              <RefreshCw />
              {t("refresh")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-3">
            <Input
              aria-label={t("ref")}
              className="max-w-64"
              onChange={(event) => setRef(event.target.value)}
              placeholder={t("ref")}
              value={ref}
            />
            <Button
              disabled={actionBusy || !projectId || !ref.trim()}
              onClick={create}
            >
              <Play />
              {t("runPipeline")}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("autoRetry")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label={t("autoRetry")}
              className="max-w-36"
              min={1}
              max={100}
              onChange={(event) => setMaxAttempts(event.target.value)}
              type="number"
              value={maxAttempts}
            />
            <Button
              disabled={
                actionBusy ||
                !projectId ||
                !Number.isInteger(Number(maxAttempts)) ||
                Number(maxAttempts) < 1 ||
                Number(maxAttempts) > 100
              }
              onClick={saveAutoRetry}
              variant="outline"
            >
              <RotateCcw />
              {t("enableAutoRetry")}
            </Button>
          </div>
          {autoRetryRules.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("noAutoRetryRules")}
            </p>
          ) : (
            autoRetryRules.map((rule) => (
              <div
                className="flex items-center justify-between gap-3 rounded border p-3 text-sm"
                key={rule.id}
              >
                <div>
                  <p className="font-medium">
                    {rule.pipelineId
                      ? `#${rule.pipelineId}`
                      : t("allPipelines")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("attempts", { count: rule.maxAttempts })} ·{" "}
                    {rule.attempts}
                  </p>
                  {rule.lastError && (
                    <p className="text-xs text-destructive">{rule.lastError}</p>
                  )}
                </div>
                <Button
                  disabled={actionBusy}
                  onClick={() => deleteAutoRetry(rule.id)}
                  size="sm"
                  variant="ghost"
                >
                  <Trash2 />
                  <span className="sr-only">{t("delete")}</span>
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
      <Card className="gap-0 py-0">
        <GitLabPipelinesTable
          key={currentScope}
          pipelines={pipelines}
          onChanged={load}
          pollIntervalSeconds={
            configuration.settings.pipelinePollIntervalSeconds
          }
        />
      </Card>
      <PaginationControls
        busy={busy}
        onPageChange={setPage}
        pagination={pagination}
      />
    </section>
  );
}

export { GitLabCommentsPage } from "./comments-page";

export function GitLabWebhooksPage() {
  const t = useTranslations("gitlabPages");
  const { configuration, loading } = useConfiguration();
  const [deliveries, setDeliveries] = useState<GitLabWebhookDeliveryView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        gitlabWebhookDeliveries: { items: GitLabWebhookDeliveryView[] };
      }>(
        `query GitLabWebhookDeliveries { gitlabWebhookDeliveries { items { id webhookId eventType projectId objectKind action outcome error receivedAt processedAt } } }`,
      );
      setDeliveries(data.gitlabWebhookDeliveries.items);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, []);
  useEffect(() => {
    if (!configuration?.settings.configured) return;
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [configuration?.settings.configured, load]);
  if (loading) return <Spinner />;
  if (!configuration?.settings.configured) return <ProviderNotConfigured />;
  return (
    <section className="space-y-6">
      <PageHeader
        description={t("webhooksDescription")}
        title={t("webhooksTitle")}
      />
      <ErrorAlert error={error} />
      <Card>
        <CardHeader>
          <CardTitle>{t("projectHooks")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {configuration.projects.map((project) => (
            <div
              className="flex items-center justify-between gap-3 rounded border p-3"
              key={project.id}
            >
              <div>
                <p className="text-sm font-medium">
                  {project.pathWithNamespace}
                </p>
                <p className="text-xs text-muted-foreground">
                  {project.webhookState}
                  {project.webhookLastReceivedAt
                    ? ` · ${project.webhookLastReceivedAt}`
                    : ""}
                </p>
              </div>
              <Badge variant="outline">
                <Webhook className="mr-1 size-3" />
                {project.webhookState}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t("deliveries")}</CardTitle>
            <Button
              onClick={() => void load()}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw />
              {t("refresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {deliveries.map((delivery) => (
            <div
              className="grid gap-1 rounded border p-3 text-sm sm:grid-cols-[1fr_auto]"
              key={delivery.id}
            >
              <div>
                <p className="font-medium">{delivery.eventType}</p>
                <p className="text-xs text-muted-foreground">
                  {delivery.objectKind ?? "—"} · {delivery.action ?? "—"} ·{" "}
                  {delivery.receivedAt}
                </p>
                {delivery.error && (
                  <p className="text-xs text-destructive">{delivery.error}</p>
                )}
              </div>
              <Badge variant="outline">{delivery.outcome}</Badge>
            </div>
          ))}
          {deliveries.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("noDeliveries")}</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export function GitLabCachePage() {
  const t = useTranslations("gitlabPages");
  const { configuration, loading } = useConfiguration();
  const [entries, setEntries] = useState<GitLabCacheEntryView[]>([]);
  const [calls, setCalls] = useState<GitLabApiCallView[]>([]);
  const [overrides, setOverrides] = useState<
    Array<{ operation: string; ttlSeconds: number }>
  >([]);
  const [rateLimits, setRateLimits] = useState<
    Array<{
      id: string;
      resource: string;
      limit: number;
      remaining: number;
      resetAt: string | null;
      observedAt: string;
    }>
  >([]);
  const [ttlMinutes, setTtlMinutes] = useState("5");
  const [overrideOperation, setOverrideOperation] = useState("");
  const [overrideSeconds, setOverrideSeconds] = useState("300");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        gitlabCachedEntries: { items: GitLabCacheEntryView[] };
        gitlabApiCalls: { items: GitLabApiCallView[] };
        gitlabCacheTtlOverrides: Array<{
          operation: string;
          ttlSeconds: number;
        }>;
        gitlabRateLimitSnapshots: Array<{
          id: string;
          resource: string;
          limit: number;
          remaining: number;
          resetAt: string | null;
          observedAt: string;
        }>;
      }>(
        `query GitLabCachePage { gitlabCachedEntries { items { id operation endpoint fetchedAt stale } } gitlabApiCalls { items { id method endpoint operation requestSource requestSummary source durationMs statusCode error servedStale rateLimitLimit rateLimitRemaining rateLimitResetAt requestId createdAt } } gitlabCacheTtlOverrides { operation ttlSeconds } gitlabRateLimitSnapshots { id resource limit remaining resetAt observedAt } }`,
      );
      setEntries(data.gitlabCachedEntries.items);
      setCalls(data.gitlabApiCalls.items);
      setOverrides(data.gitlabCacheTtlOverrides);
      setRateLimits(data.gitlabRateLimitSnapshots);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, []);
  useEffect(() => {
    if (!configuration?.settings.configured) return;
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [configuration?.settings.configured, load]);
  const clear = async () => {
    try {
      await controlPlaneRequest(
        "mutation ClearGitLabCache { clearGitLabCache }",
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const remove = async (id: string) => {
    try {
      await controlPlaneRequest(
        "mutation DeleteGitLabCachedEntry($id: ID!) { deleteGitLabCachedEntry(id: $id) }",
        { id },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const saveDefaultTtl = async () => {
    try {
      await controlPlaneRequest(
        "mutation UpdateGitLabCacheTtl($minutes: Int!) { updateGitLabCacheTtl(ttlMinutes: $minutes) { cacheTtlSeconds } }",
        { minutes: Number(ttlMinutes) },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const saveOverride = async () => {
    try {
      await controlPlaneRequest(
        "mutation SaveGitLabCacheOverride($operation: String!, $seconds: Int!) { saveGitLabCacheTtlOverride(operation: $operation, ttlSeconds: $seconds) { operation } }",
        {
          operation: overrideOperation.trim(),
          seconds: Number(overrideSeconds),
        },
      );
      setOverrideOperation("");
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const deleteOverride = async (operation: string) => {
    try {
      await controlPlaneRequest(
        "mutation DeleteGitLabCacheOverride($operation: String!) { deleteGitLabCacheTtlOverride(operation: $operation) { operation } }",
        { operation },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  if (loading) return <Spinner />;
  if (!configuration?.settings.configured) return <ProviderNotConfigured />;
  return (
    <section className="space-y-6">
      <PageHeader description={t("cacheDescription")} title={t("cacheTitle")} />
      <ErrorAlert error={error} />
      <Card>
        <CardHeader>
          <CardTitle>{t("cacheControls")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Input
              className="max-w-40"
              min={1}
              max={1440}
              onChange={(event) => setTtlMinutes(event.target.value)}
              type="number"
              value={ttlMinutes}
            />
            <Button
              onClick={() => void saveDefaultTtl()}
              type="button"
              variant="outline"
            >
              {t("saveDefaultTtl")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              className="max-w-64"
              onChange={(event) => setOverrideOperation(event.target.value)}
              placeholder={t("operation")}
              value={overrideOperation}
            />
            <Input
              className="max-w-40"
              min={1}
              max={86400}
              onChange={(event) => setOverrideSeconds(event.target.value)}
              type="number"
              value={overrideSeconds}
            />
            <Button
              disabled={!overrideOperation.trim()}
              onClick={() => void saveOverride()}
              type="button"
              variant="outline"
            >
              {t("saveOverride")}
            </Button>
          </div>
          {overrides.map((override) => (
            <div
              className="flex items-center justify-between gap-3 text-sm"
              key={override.operation}
            >
              <span>
                {override.operation} · {override.ttlSeconds}s
              </span>
              <Button
                onClick={() => void deleteOverride(override.operation)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Trash2 />
                <span className="sr-only">{t("delete")}</span>
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{t("cacheEntries")}</CardTitle>
            <div className="flex gap-2">
              <Button
                onClick={() => void load()}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw />
                {t("refresh")}
              </Button>
              <Button
                onClick={() => void clear()}
                size="sm"
                type="button"
                variant="outline"
              >
                <Trash2 />
                {t("clear")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {entries.map((entry) => (
            <div
              className="flex items-center justify-between gap-3 rounded border p-3"
              key={entry.id}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{entry.operation}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {entry.endpoint}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">
                  {entry.stale ? t("stale") : t("fresh")}
                </Badge>
                <Button
                  onClick={() => void remove(entry.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 />
                  <span className="sr-only">{t("delete")}</span>
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("rateLimits")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {rateLimits.map((rate) => (
            <div
              className="flex items-center justify-between rounded border p-3 text-sm"
              key={rate.id}
            >
              <span>{rate.resource}</span>
              <span>
                {rate.remaining} / {rate.limit}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("apiCalls")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {calls.map((call) => (
            <div
              className="grid gap-1 rounded border p-3 text-sm sm:grid-cols-[1fr_auto]"
              key={call.id}
            >
              <div>
                <p className="font-medium">
                  {call.method} · {call.operation}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {call.endpoint}
                </p>
                {call.error && (
                  <p className="text-xs text-destructive">{call.error}</p>
                )}
              </div>
              <div className="text-right">
                <Badge variant="outline">{call.source}</Badge>
                <p className="mt-1 text-xs text-muted-foreground">
                  {call.durationMs} ms
                </p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
