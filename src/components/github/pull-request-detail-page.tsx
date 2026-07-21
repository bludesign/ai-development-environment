"use client";

import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  GitBranch,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Fragment, MouseEvent, useCallback, useEffect, useState } from "react";

import {
  PipelineMenu,
  RetryPipelineButton,
  pipelineStateClass,
} from "@/components/github/pipeline-menu";
import { GitHubMarkdownBlock } from "@/components/github/github-markdown";
import { MergePullRequestButton } from "@/components/github/merge-pull-request-button";
import { ReviewThreadCard } from "@/components/github/review-thread-card";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { worktreeDetailHref } from "@/components/worktrees/worktree-navigation";
import type {
  GitHubPipelineView,
  GitHubPullRequestDetail,
  GitHubReviewComment,
  GitHubReviewDecision,
  GitHubReviewThreadState,
  GitHubWorkflowJobView,
} from "@/services/github/types";

const DETAIL_FIELDS =
  "id number title url repositoryGithubId repositoryNameWithOwner repositoryUrl labels jiraKey pipelineStatus pipelines { id name status url checkSuiteId canRetry retryUnavailableReason jobs { id name status url canRetry retryUnavailableReason steps { number name status } } } reviewDecision unresolvedReviewThreadCount headRefName createdAt body bodyHtml author { login avatarUrl url } assignees { login avatarUrl url } reviewThreads { id isResolved isOutdated subjectType path line startLine originalLine originalStartLine viewerCanReply viewerCanResolve viewerCanUnresolve resolvedBy { login avatarUrl url } pullRequest { id number title url repositoryNameWithOwner } rootComment { id body bodyText bodyHtml url author { login avatarUrl url } createdAt updatedAt } replies { id body bodyText bodyHtml url author { login avatarUrl url } createdAt updatedAt } } baseRefName state isDraft mergeable additions deletions changedFiles commitCount updatedAt mergedAt worktreeId";

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

export function PullRequestDetailPage({
  owner,
  repository,
  number,
}: {
  owner: string;
  repository: string;
  number: number;
}) {
  const t = useTranslations("pullRequestDetail");
  const tp = useTranslations("pullRequests");
  const locale = useLocale();
  const searchParams = useSearchParams();
  const issueKey = searchParams.get("issue");
  const [pullRequest, setPullRequest] =
    useState<GitHubPullRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        githubPullRequest: GitHubPullRequestDetail | null;
      }>(
        `query GitHubPullRequestDetail(
          $owner: String!
          $name: String!
          $number: Int!
        ) {
          githubPullRequest(owner: $owner, name: $name, number: $number) {
            ${DETAIL_FIELDS}
          }
        }`,
        { owner, name: repository, number },
      );
      setPullRequest(data.githubPullRequest);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [number, owner, repository]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const pipelineRetried = (pipeline: GitHubPipelineView) => {
    setPullRequest((current) =>
      current
        ? {
            ...current,
            pipelineStatus: "PENDING",
            pipelines: current.pipelines.map((item) =>
              item.id === pipeline.id
                ? { ...pipeline, jobs: pipeline.jobs ?? item.jobs }
                : item,
            ),
          }
        : current,
    );
  };

  const jobRetried = (pipelineId: string, jobId: string) => {
    setPullRequest((current) =>
      current
        ? {
            ...current,
            pipelineStatus: "PENDING",
            pipelines: current.pipelines.map((pipeline) =>
              pipeline.id === pipelineId
                ? {
                    ...pipeline,
                    status: "QUEUED",
                    canRetry: false,
                    retryUnavailableReason: "NOT_COMPLETED",
                    jobs: pipeline.jobs.map((job) =>
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
                  }
                : pipeline,
            ),
          }
        : current,
    );
  };

  const replyAdded = (threadId: string, comment: GitHubReviewComment) => {
    setPullRequest((current) =>
      current
        ? {
            ...current,
            reviewThreads: current.reviewThreads.map((thread) =>
              thread.id === threadId
                ? { ...thread, replies: [...thread.replies, comment] }
                : thread,
            ),
          }
        : current,
    );
  };

  const threadStateChanged = (state: GitHubReviewThreadState) => {
    setPullRequest((current) => {
      if (!current) return current;
      const previous = current.reviewThreads.find(
        (thread) => thread.id === state.id,
      );
      const countDelta =
        previous && previous.isResolved !== state.isResolved
          ? state.isResolved
            ? -1
            : 1
          : 0;
      return {
        ...current,
        unresolvedReviewThreadCount: Math.max(
          0,
          current.unresolvedReviewThreadCount + countDelta,
        ),
        reviewThreads: current.reviewThreads.map((thread) =>
          thread.id === state.id ? { ...thread, ...state } : thread,
        ),
      };
    });
  };

  if (loading && !pullRequest) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        {t("loading")}
      </div>
    );
  }

  if (!pullRequest) {
    return (
      <section className="mx-auto w-full max-w-5xl space-y-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitPullRequest />
            </EmptyMedia>
            <EmptyTitle>{t("notFound")}</EmptyTitle>
            <EmptyDescription>{t("notFoundDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button asChild className="mt-4" variant="outline">
            <Link href="/pull-requests">{t("back")}</Link>
          </Button>
        </Empty>
      </section>
    );
  }

  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const formatDate = (value: string | null) =>
    value ? dateFormatter.format(new Date(value)) : "—";

  return (
    <section className="mx-auto flex min-w-0 w-full max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Button asChild className="mb-3 -ml-2" variant="ghost">
            <Link href="/pull-requests">
              <ArrowLeft />
              {t("back")}
            </Link>
          </Button>
          <p className="text-sm text-muted-foreground">
            {pullRequest.repositoryNameWithOwner} #{pullRequest.number}
          </p>
          <h1 className="mt-1 text-2xl font-semibold break-words tracking-tight [overflow-wrap:anywhere]">
            {pullRequest.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge>{tp(`pullRequestStates.${pullRequest.state}`)}</Badge>
            {pullRequest.isDraft && <Badge>{t("draft")}</Badge>}
            <Badge className={reviewClass(pullRequest.reviewDecision)}>
              {tp(`reviewStates.${pullRequest.reviewDecision}`)}
            </Badge>
            {pullRequest.jiraKey && (
              <Badge asChild className="cursor-pointer hover:bg-muted/80">
                <button
                  onClick={() => replaceIssueParam(pullRequest.jiraKey)}
                  type="button"
                >
                  {pullRequest.jiraKey}
                </button>
              </Badge>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {pullRequest.worktreeId && (
            <Button asChild variant="outline">
              <Link href={worktreeDetailHref(pullRequest.worktreeId)}>
                <GitBranch />
                {t("viewWorktree")}
              </Link>
            </Button>
          )}
          {pullRequest.state === "OPEN" && (
            <MergePullRequestButton
              onMerged={load}
              pullRequest={pullRequest}
              size="default"
            />
          )}
          <Button
            disabled={loading}
            onClick={() => void load()}
            variant="outline"
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
          <Button asChild>
            <a href={pullRequest.url} rel="noreferrer" target="_blank">
              {t("openInGitHub")}
              <ExternalLink />
            </a>
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <div className="contents">
          <Card className="min-w-0 order-2 lg:col-span-2">
            <CardContent>
              <GitHubMarkdownBlock
                body={pullRequest.body}
                bodyHtml={pullRequest.bodyHtml}
                emptyLabel={t("noDescription")}
                header={<CardTitle>{t("description")}</CardTitle>}
                headerClassName="border-b pb-4"
              />
            </CardContent>
          </Card>

          <div className="min-w-0 order-3 space-y-4 lg:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{t("comments")}</h2>
              <Badge variant="secondary">
                {pullRequest.reviewThreads.length}
              </Badge>
            </div>
            {pullRequest.reviewThreads.length === 0 ? (
              <Empty className="border py-8">
                <EmptyHeader>
                  <EmptyTitle>{t("noComments")}</EmptyTitle>
                  <EmptyDescription>
                    {t("noCommentsDescription")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="space-y-5">
                {pullRequest.reviewThreads.map((thread) => (
                  <ReviewThreadCard
                    key={thread.id}
                    locale={locale}
                    onReplyAdded={replyAdded}
                    onStateChanged={threadStateChanged}
                    thread={thread}
                  />
                ))}
              </div>
            )}
          </div>

          <Card className="min-w-0 order-4 gap-0 py-0 lg:col-span-2">
            <CardHeader className="flex grid-cols-none flex-row items-center justify-between gap-3">
              <div>
                <CardTitle>{t("pipelines")}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {t("pipelineCount", { count: pullRequest.pipelines.length })}
                </p>
              </div>
              <PipelineMenu
                onPipelineRetried={pipelineRetried}
                pipelineStatus={pullRequest.pipelineStatus}
                pipelines={pullRequest.pipelines}
                repositoryId={pullRequest.repositoryGithubId}
              />
            </CardHeader>
            <CardContent className="px-0">
              {pullRequest.pipelines.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {tp("noPipelines")}
                </p>
              ) : (
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
                    {pullRequest.pipelines.map((pipeline) => (
                      <Fragment key={pipeline.id}>
                        <TableRow>
                          <TableCell className="font-medium">
                            {pipeline.name}
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={pipelineStateClass(pipeline.status)}
                            >
                              {tp(`pipelineStates.${pipeline.status}`)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-2">
                              {pipeline.url ? (
                                <Button asChild size="sm" variant="outline">
                                  <a
                                    href={pipeline.url}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    {t("viewPipeline")}
                                    <ExternalLink />
                                  </a>
                                </Button>
                              ) : (
                                <Button disabled size="sm" variant="outline">
                                  {t("viewPipeline")}
                                  <ExternalLink />
                                </Button>
                              )}
                              <RetryPipelineButton
                                onError={setError}
                                onPipelineRetried={pipelineRetried}
                                pipeline={pipeline}
                                repositoryId={pullRequest.repositoryGithubId}
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                        <TableRow className="bg-muted/20 hover:bg-muted/20">
                          <TableCell className="p-0" colSpan={3}>
                            <div className="border-l-2 border-muted-foreground/20 px-4 py-1">
                              <p className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {t("jobCount", {
                                  count: pipeline.jobs.length,
                                })}
                              </p>
                              {pipeline.jobs.length === 0 ? (
                                <p className="px-3 pb-3 text-sm text-muted-foreground">
                                  {t("noJobs")}
                                </p>
                              ) : (
                                <div className="divide-y">
                                  {pipeline.jobs.map((job) => (
                                    <WorkflowJob
                                      checkSuiteId={pipeline.checkSuiteId}
                                      job={job}
                                      key={job.id}
                                      onError={setError}
                                      onRetried={() =>
                                        jobRetried(pipeline.id, job.id)
                                      }
                                      repositoryId={
                                        pullRequest.repositoryGithubId
                                      }
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="contents">
          <Card className="min-w-0 order-1">
            <CardHeader>
              <CardTitle>{t("details")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm">
                <DetailRow label={t("branches")}>
                  <span className="font-mono text-xs break-all">
                    {pullRequest.headRefName} → {pullRequest.baseRefName}
                  </span>
                </DetailRow>
                <DetailRow label={t("changes")}>
                  <span className="text-emerald-600">
                    +{pullRequest.additions}
                  </span>{" "}
                  <span className="text-red-600">−{pullRequest.deletions}</span>
                </DetailRow>
                <DetailRow label={t("files")}>
                  {pullRequest.changedFiles ?? "—"}
                </DetailRow>
                <DetailRow label={t("commits")}>
                  <span className="inline-flex items-center gap-1">
                    <GitCommitHorizontal className="size-4" />
                    {pullRequest.commitCount}
                  </span>
                </DetailRow>
                <DetailRow label={t("mergeable")}>
                  {tp(`mergeableStates.${pullRequest.mergeable}`)}
                </DetailRow>
                <DetailRow label={t("openComments")}>
                  {pullRequest.unresolvedReviewThreadCount}
                </DetailRow>
                <DetailRow label={t("created")}>
                  {formatDate(pullRequest.createdAt)}
                </DetailRow>
                <DetailRow label={t("updated")}>
                  {formatDate(pullRequest.updatedAt)}
                </DetailRow>
                {pullRequest.mergedAt && (
                  <DetailRow label={t("merged")}>
                    {formatDate(pullRequest.mergedAt)}
                  </DetailRow>
                )}
              </dl>
            </CardContent>
          </Card>

          <Card className="min-w-0 order-1">
            <CardHeader>
              <CardTitle>{t("people")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Person
                label={t("author")}
                person={pullRequest.author}
                unknownLabel={t("unknown")}
              />
              <div>
                <p className="mb-2 text-xs text-muted-foreground">
                  {t("assignees")}
                </p>
                {pullRequest.assignees.length === 0 ? (
                  <p className="text-sm">{t("unassigned")}</p>
                ) : (
                  <div className="space-y-2">
                    {pullRequest.assignees.map((assignee) => (
                      <Person
                        key={assignee.login}
                        person={assignee}
                        unknownLabel={t("unknown")}
                      />
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <JiraTicketDrawer
        issueKey={issueKey}
        onClose={() => replaceIssueParam(null)}
      />
    </section>
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
  const t = useTranslations("pullRequestDetail");
  const tp = useTranslations("pullRequests");
  const [expanded, setExpanded] = useState(false);

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
        {job.url && (
          <Button asChild size="sm" variant="outline">
            <a
              aria-label={t("viewJob", { job: job.name })}
              href={job.url}
              rel="noreferrer"
              target="_blank"
            >
              {t("viewPipeline")}
              <ExternalLink />
            </a>
          </Button>
        )}
        <RetryWorkflowJobButton
          checkSuiteId={checkSuiteId}
          job={job}
          onError={onError}
          onRetried={onRetried}
          repositoryId={repositoryId}
        />
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

function RetryWorkflowJobButton({
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
  const t = useTranslations("pullRequestDetail");
  const tp = useTranslations("pullRequests");
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
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

function Person({
  label,
  person,
  unknownLabel,
}: {
  label?: string;
  person: { login: string; avatarUrl: string; url: string } | null;
  unknownLabel: string;
}) {
  return (
    <div>
      {label && <p className="mb-2 text-xs text-muted-foreground">{label}</p>}
      {person ? (
        <a
          className="flex items-center gap-2 text-sm hover:underline"
          href={person.url}
          rel="noreferrer"
          target="_blank"
        >
          <Avatar className="size-6">
            <AvatarImage alt="" src={person.avatarUrl} />
            <AvatarFallback>
              {person.login.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          @{person.login}
        </a>
      ) : (
        <p className="text-sm">{unknownLabel}</p>
      )}
    </div>
  );
}
