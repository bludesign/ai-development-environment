"use client";

import {
  CheckCircle2,
  ExternalLink,
  GitMerge,
  GitFork,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Webhook,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitLabApiCallView,
  GitLabAutoRetryRuleView,
  GitLabCacheEntryView,
  GitLabDiscussionView,
  GitLabJobView,
  GitLabMergeRequestDetailView,
  GitLabMergeRequestScope,
  GitLabMergeRequestView,
  GitLabPipelineView,
  GitLabProjectView,
  GitLabSettingsView,
  GitLabWebhookDeliveryView,
} from "@/services/gitlab";

const SETTINGS = "configured baseUrl version tokenConfigured";
const PROJECT =
  "id name pathWithNamespace webUrl defaultBranch visibility enabled webhookId webhookState webhookError webhookConfiguredAt webhookLastReceivedAt";
const USER = "id username name avatarUrl webUrl";
const PIPELINE =
  "id projectId iid ref sha source status webUrl createdAt updatedAt finishedAt duration queuedDuration";
const MR = `id iid projectId title description state draft webUrl sourceBranch targetBranch sha
  author { ${USER} } reviewers { ${USER} } labels detailedMergeStatus mergeWhenPipelineSucceeds
  squashOnMerge hasConflicts blockingDiscussionsResolved createdAt updatedAt mergedAt`;
const DISCUSSION = `id individualNote notes {
  id body author { ${USER} } createdAt updatedAt system resolvable resolved resolvedBy { ${USER} }
}`;

type Configuration = {
  settings: GitLabSettingsView;
  projects: GitLabProjectView[];
};

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
          <Link href="/settings#settings-integrations">
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
    <select
      aria-label={t("project")}
      className="h-9 min-w-56 rounded-md border bg-background px-3 text-sm"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {allowAll && <option value="">{t("allProjects")}</option>}
      {!allowAll && !value && <option value="">{t("chooseProject")}</option>}
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.pathWithNamespace}
        </option>
      ))}
    </select>
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
  const reload = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        gitlabSettings: GitLabSettingsView;
        gitlabProjects: GitLabProjectView[];
      }>(`query GitLabPageConfiguration {
        gitlabSettings { ${SETTINGS} }
        gitlabProjects { ${PROJECT} }
      }`);
      setConfiguration({
        settings: data.gitlabSettings,
        projects: data.gitlabProjects,
      });
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timeout = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timeout);
  }, [reload]);
  return { configuration, loading, error, reload };
}

export function GitLabMergeRequestsPage() {
  const t = useTranslations("gitlabPages");
  const {
    configuration,
    loading,
    error: configurationError,
  } = useConfiguration();
  const [items, setItems] = useState<GitLabMergeRequestView[]>([]);
  const [scope, setScope] = useState<GitLabMergeRequestScope>("MINE");
  const [projectId, setProjectId] = useState("");
  const [state, setState] = useState("OPENED");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!configuration?.settings.configured) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        gitlabMergeRequests: { items: GitLabMergeRequestView[] };
      }>(
        `query GitLabMergeRequests($scope: GitLabMergeRequestScope!, $projectId: ID, $state: GitLabMergeRequestState!) {
        gitlabMergeRequests(scope: $scope, projectId: $projectId, state: $state) { items { ${MR} } }
      }`,
        {
          scope: projectId ? "PROJECT" : scope,
          projectId: projectId || null,
          state,
        },
      );
      setItems(data.gitlabMergeRequests.items);
      setError(null);
    } catch (value) {
      setItems([]);
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }, [configuration?.settings.configured, projectId, scope, state]);

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
        description={t("mergeRequestsDescription")}
        title={t("mergeRequestsTitle")}
      />
      <ErrorAlert error={configurationError ?? error} />
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <ProjectSelect
            allowAll
            onChange={setProjectId}
            projects={configuration.projects}
            value={projectId}
          />
          <select
            aria-label={t("scope")}
            className="h-9 rounded-md border bg-background px-3 text-sm"
            disabled={Boolean(projectId)}
            onChange={(event) =>
              setScope(event.target.value as GitLabMergeRequestScope)
            }
            value={scope}
          >
            <option value="ALL">{t("allAccessible")}</option>
            <option value="MINE">{t("authoredByMe")}</option>
            <option value="REVIEW_REQUESTED">{t("reviewRequested")}</option>
          </select>
          <select
            aria-label={t("state")}
            className="h-9 rounded-md border bg-background px-3 text-sm"
            onChange={(event) => setState(event.target.value)}
            value={state}
          >
            <option value="OPENED">{t("open")}</option>
            <option value="MERGED">{t("merged")}</option>
            <option value="CLOSED">{t("closed")}</option>
            <option value="ALL">{t("all")}</option>
          </select>
          <Button
            disabled={busy}
            onClick={() => void load()}
            type="button"
            variant="outline"
          >
            {busy ? <Spinner /> : <RefreshCw />}
            {t("refresh")}
          </Button>
        </CardContent>
      </Card>
      <div className="space-y-3">
        {items.length === 0 && !busy && !error ? (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              {t("noMergeRequests")}
            </CardContent>
          </Card>
        ) : (
          items.map((mr) => (
            <Card key={mr.id}>
              <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <Link
                    className="font-medium text-primary hover:underline"
                    href={`/gitlab/merge-requests/${mr.projectId}/${mr.iid}`}
                  >
                    {mr.title}
                  </Link>
                  <p className="mt-1 text-xs text-muted-foreground">
                    !{mr.iid} · {mr.sourceBranch} → {mr.targetBranch} · @
                    {mr.author.username}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {mr.labels.map((label) => (
                      <Badge key={label} variant="secondary">
                        {label}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Badge variant="outline">{mr.state}</Badge>
                  <Badge variant="outline">{mr.detailedMergeStatus}</Badge>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
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
  const { configuration, loading: configurationLoading } = useConfiguration();
  const [mr, setMr] = useState<GitLabMergeRequestDetailView | null>(null);
  const [reviewBody, setReviewBody] = useState("");
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!configuration?.settings.configured) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        gitlabMergeRequest: GitLabMergeRequestDetailView;
      }>(
        `query GitLabMergeRequest($projectId: ID!, $iid: Int!) {
        gitlabMergeRequest(projectId: $projectId, iid: $iid) {
          ${MR} changesCount commitsCount discussions { ${DISCUSSION} } pipelines { ${PIPELINE} }
        }
      }`,
        { projectId, iid },
      );
      setMr(data.gitlabMergeRequest);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }, [configuration?.settings.configured, iid, projectId]);

  useEffect(() => {
    if (!configuration?.settings.configured) return;
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [configuration?.settings.configured, load]);

  const review = async (outcome: "APPROVE" | "COMMENT" | "REQUEST_CHANGES") => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation SubmitGitLabReview($input: SubmitGitLabReviewInput!) {
        submitGitLabReview(input: $input)
      }`,
        { input: { projectId, iid, outcome, body: reviewBody || null } },
      );
      setReviewBody("");
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };

  const merge = async (autoMerge: boolean) => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation MergeGitLabMergeRequest($input: MergeGitLabMergeRequestInput!) {
        mergeGitLabMergeRequest(input: $input) { id }
      }`,
        {
          input: {
            projectId,
            iid,
            autoMerge,
            squash: mr?.squashOnMerge ?? false,
            sha: mr?.sha,
          },
        },
      );
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
        `mutation ReplyToGitLabDiscussion($input: GitLabDiscussionInput!, $body: String!) {
        replyToGitLabDiscussion(input: $input, body: $body) { id }
      }`,
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
        `mutation ResolveGitLabDiscussion($input: GitLabDiscussionInput!, $resolved: Boolean!) {
        setGitLabDiscussionResolved(input: $input, resolved: $resolved) { id }
      }`,
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
  return (
    <section className="space-y-6">
      <ErrorAlert error={error} />
      {mr && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                {mr.title}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                !{mr.iid} · {mr.sourceBranch} → {mr.targetBranch}
              </p>
            </div>
            <Button asChild variant="outline">
              <a href={mr.webUrl} rel="noreferrer" target="_blank">
                {t("openInGitLab")}
                <ExternalLink />
              </a>
            </Button>
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>{t("description")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="whitespace-pre-wrap text-sm">
                    {mr.description || t("noDescription")}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("review")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Textarea
                    onChange={(event) => setReviewBody(event.target.value)}
                    placeholder={t("reviewSummary")}
                    value={reviewBody}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => void review("APPROVE")}
                      type="button"
                    >
                      <CheckCircle2 />
                      {t("approve")}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => void review("COMMENT")}
                      type="button"
                      variant="outline"
                    >
                      {t("comment")}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => void review("REQUEST_CHANGES")}
                      type="button"
                      variant="outline"
                    >
                      {t("requestChanges")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("discussions")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {mr.discussions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("noDiscussions")}
                    </p>
                  ) : (
                    mr.discussions.map((discussion) => {
                      const resolvable = discussion.notes.some(
                        (note) => note.resolvable,
                      );
                      const resolved = discussion.notes.some(
                        (note) => note.resolved,
                      );
                      return (
                        <div
                          className="space-y-3 rounded-lg border p-3"
                          key={discussion.id}
                        >
                          {discussion.notes.map((note) => (
                            <div key={note.id}>
                              <p className="text-xs font-medium">
                                @{note.author.username}
                              </p>
                              <p className="mt-1 whitespace-pre-wrap text-sm">
                                {note.body}
                              </p>
                            </div>
                          ))}
                          <Textarea
                            onChange={(event) =>
                              setReplyBodies((items) => ({
                                ...items,
                                [discussion.id]: event.target.value,
                              }))
                            }
                            placeholder={t("reply")}
                            value={replyBodies[discussion.id] ?? ""}
                          />
                          <div className="flex gap-2">
                            <Button
                              disabled={
                                busy ||
                                !(replyBodies[discussion.id] ?? "").trim()
                              }
                              onClick={() => void reply(discussion.id)}
                              size="sm"
                              type="button"
                            >
                              {t("reply")}
                            </Button>
                            {resolvable && (
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  void resolve(discussion, !resolved)
                                }
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                {resolved ? t("reopen") : t("resolve")}
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>
            </div>
            <div className="space-y-4">
              <Card>
                <CardContent className="space-y-3 py-4">
                  <Badge>{mr.state}</Badge>
                  <p className="text-sm">{mr.detailedMergeStatus}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("commits", { count: mr.commitsCount })} ·{" "}
                    {t("changes", { count: mr.changesCount ?? "—" })}
                  </p>
                  <Button
                    className="w-full"
                    disabled={busy || mr.state !== "OPENED"}
                    onClick={() => void merge(false)}
                    type="button"
                  >
                    <GitMerge />
                    {t("merge")}
                  </Button>
                  <Button
                    className="w-full"
                    disabled={busy || mr.state !== "OPENED"}
                    onClick={() => void merge(true)}
                    type="button"
                    variant="outline"
                  >
                    {t("autoMerge")}
                  </Button>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("pipelines")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {mr.pipelines.map((pipeline) => (
                    <a
                      className="flex items-center justify-between gap-2 rounded border p-2 text-sm hover:bg-muted/50"
                      href={pipeline.webUrl}
                      key={pipeline.id}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <span>
                        #{pipeline.id} · {pipeline.ref}
                      </span>
                      <Badge variant="outline">{pipeline.status}</Badge>
                    </a>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </section>
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
  const [jobs, setJobs] = useState<Record<string, GitLabJobView[]>>({});
  const [ref, setRef] = useState("");
  const [autoRetryRules, setAutoRetryRules] = useState<
    GitLabAutoRetryRuleView[]
  >([]);
  const [maxAttempts, setMaxAttempts] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId && configuration?.projects[0]) {
      const firstProject = configuration.projects[0];
      const timeout = window.setTimeout(() => {
        setProjectId(firstProject.id);
        setRef(firstProject.defaultBranch ?? "main");
      }, 0);
      return () => window.clearTimeout(timeout);
    }
  }, [configuration?.projects, projectId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        gitlabPipelines: { items: GitLabPipelineView[] };
        gitlabAutoRetryRules: GitLabAutoRetryRuleView[];
      }>(
        `query GitLabPipelines($projectId: ID!) { gitlabPipelines(projectId: $projectId) { items { ${PIPELINE} } } gitlabAutoRetryRules(projectId: $projectId) { id projectId pipelineId enabled maxAttempts attempts lastError lastAttemptAt createdAt updatedAt executions { id pipelineId attempt status lastError createdAt updatedAt } } }`,
        { projectId },
      );
      setPipelines(data.gitlabPipelines.items);
      setAutoRetryRules(data.gitlabAutoRetryRules);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load, projectId]);

  const loadJobs = async (pipelineId: string) => {
    try {
      const data = await controlPlaneRequest<{
        gitlabPipelineJobs: GitLabJobView[];
      }>(
        `query GitLabPipelineJobs($projectId: ID!, $pipelineId: ID!) { gitlabPipelineJobs(projectId: $projectId, pipelineId: $pipelineId) { id pipelineId name stage status ref webUrl allowFailure createdAt startedAt finishedAt duration queuedDuration retried } }`,
        { projectId, pipelineId },
      );
      setJobs((items) => ({ ...items, [pipelineId]: data.gitlabPipelineJobs }));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const pipelineMutation = async (
    operation: "retry" | "cancel",
    pipelineId: string,
  ) => {
    setBusy(true);
    try {
      const mutation =
        operation === "retry" ? "retryGitLabPipeline" : "cancelGitLabPipeline";
      await controlPlaneRequest(
        `mutation GitLabPipelineAction($projectId: ID!, $pipelineId: ID!) { ${mutation}(projectId: $projectId, pipelineId: $pipelineId) { id } }`,
        { projectId, pipelineId },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };

  const create = async () => {
    if (!projectId || !ref.trim()) return;
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation CreateGitLabPipeline($projectId: ID!, $ref: String!) { createGitLabPipeline(projectId: $projectId, ref: $ref) { id } }`,
        { projectId, ref: ref.trim() },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };

  const retryJob = async (jobId: string, pipelineId: string) => {
    try {
      await controlPlaneRequest(
        `mutation RetryGitLabJob($projectId: ID!, $jobId: ID!) { retryGitLabJob(projectId: $projectId, jobId: $jobId) { id } }`,
        { projectId, jobId },
      );
      await loadJobs(pipelineId);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const saveAutoRetry = async (pipelineId?: string) => {
    const attempts = Number(maxAttempts);
    if (!projectId || !Number.isInteger(attempts)) return;
    try {
      await controlPlaneRequest(
        `mutation SaveGitLabAutoRetryRule($input: SaveGitLabAutoRetryRuleInput!) { saveGitLabAutoRetryRule(input: $input) { id } }`,
        {
          input: {
            projectId,
            pipelineId,
            maxAttempts: attempts,
            enabled: true,
          },
        },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const deleteAutoRetry = async (id: string) => {
    try {
      await controlPlaneRequest(
        `mutation DeleteGitLabAutoRetryRule($id: ID!) { deleteGitLabAutoRetryRule(id: $id) }`,
        { id },
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
      <PageHeader
        description={t("pipelinesDescription")}
        title={t("pipelinesTitle")}
      />
      <ErrorAlert error={configurationError ?? error} />
      <Card>
        <CardContent className="flex flex-wrap gap-3 py-4">
          <ProjectSelect
            onChange={(value) => {
              setProjectId(value);
              const project = configuration.projects.find(
                (item) => item.id === value,
              );
              setRef(project?.defaultBranch ?? "main");
            }}
            projects={configuration.projects}
            value={projectId}
          />
          <Input
            className="max-w-64"
            onChange={(event) => setRef(event.target.value)}
            placeholder={t("ref")}
            value={ref}
          />
          <Button
            disabled={busy || !projectId || !ref.trim()}
            onClick={() => void create()}
            type="button"
          >
            <Play />
            {t("runPipeline")}
          </Button>
          <Button
            disabled={busy || !projectId}
            onClick={() => void load()}
            type="button"
            variant="outline"
          >
            <RefreshCw />
            {t("refresh")}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("autoRetry")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              className="max-w-36"
              min={1}
              max={100}
              onChange={(event) => setMaxAttempts(event.target.value)}
              type="number"
              value={maxAttempts}
            />
            <Button
              disabled={!projectId}
              onClick={() => void saveAutoRetry()}
              type="button"
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
                  onClick={() => void deleteAutoRetry(rule.id)}
                  size="sm"
                  type="button"
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
      <div className="space-y-3">
        {pipelines.map((pipeline) => (
          <Card key={pipeline.id}>
            <CardContent className="space-y-3 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <a
                    className="font-medium text-primary hover:underline"
                    href={pipeline.webUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    #{pipeline.id} · {pipeline.ref}
                  </a>
                  <p className="text-xs text-muted-foreground">
                    {pipeline.source} · {pipeline.sha.slice(0, 8)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{pipeline.status}</Badge>
                  <Button
                    disabled={busy}
                    onClick={() => void loadJobs(pipeline.id)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {t("jobs")}
                  </Button>
                  <Button
                    disabled={
                      busy || !["FAILED", "CANCELED"].includes(pipeline.status)
                    }
                    onClick={() => void pipelineMutation("retry", pipeline.id)}
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
                    onClick={() => void pipelineMutation("cancel", pipeline.id)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Square />
                    {t("cancel")}
                  </Button>
                </div>
              </div>
              {jobs[pipeline.id] && (
                <div className="space-y-2 border-t pt-3">
                  {jobs[pipeline.id].map((job) => (
                    <div
                      className="flex items-center justify-between gap-3 text-sm"
                      key={job.id}
                    >
                      <a
                        className="text-primary hover:underline"
                        href={job.webUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {job.stage} / {job.name}
                      </a>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{job.status}</Badge>
                        <Button
                          disabled={
                            !["FAILED", "CANCELED"].includes(job.status)
                          }
                          onClick={() => void retryJob(job.id, pipeline.id)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <RotateCcw />
                          <span className="sr-only">{t("retry")}</span>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

export function GitLabCommentsPage() {
  const t = useTranslations("gitlabPages");
  const { configuration, loading } = useConfiguration();
  const [items, setItems] = useState<GitLabMergeRequestView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!configuration?.settings.configured) return;
    const timeout = window.setTimeout(() => {
      void controlPlaneRequest<{
        gitlabMergeRequests: { items: GitLabMergeRequestView[] };
      }>(
        `query GitLabCommentMergeRequests { gitlabMergeRequests(scope: REVIEW_REQUESTED, state: OPENED) { items { ${MR} } } }`,
      )
        .then((data) => setItems(data.gitlabMergeRequests.items))
        .catch((value) =>
          setError(value instanceof Error ? value.message : String(value)),
        );
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [configuration?.settings.configured]);
  if (loading) return <Spinner />;
  if (!configuration?.settings.configured) return <ProviderNotConfigured />;
  return (
    <section className="space-y-6">
      <PageHeader
        description={t("commentsDescription")}
        title={t("commentsTitle")}
      />
      <ErrorAlert error={error} />
      <div className="space-y-3">
        {items.map((mr) => (
          <Card key={mr.id}>
            <CardContent className="py-4">
              <Link
                className="font-medium text-primary hover:underline"
                href={`/gitlab/merge-requests/${mr.projectId}/${mr.iid}`}
              >
                {mr.title}
              </Link>
              <p className="mt-1 text-xs text-muted-foreground">
                !{mr.iid} · {mr.detailedMergeStatus}
              </p>
            </CardContent>
          </Card>
        ))}
        {items.length === 0 && (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              {t("noReviewRequests")}
            </CardContent>
          </Card>
        )}
      </div>
    </section>
  );
}

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
