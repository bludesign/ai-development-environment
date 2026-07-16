"use client";

import {
  ArrowLeft,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  PipelineMenu,
  RetryPipelineButton,
  pipelineStateClass,
} from "@/components/github/pipeline-menu";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import type {
  GitHubPipelineView,
  GitHubPullRequestDetail,
  GitHubReviewDecision,
} from "@/services/github/types";

const DETAIL_FIELDS =
  "id number title url repositoryGithubId repositoryNameWithOwner repositoryUrl labels jiraKey pipelineStatus pipelines { id name status url checkSuiteId canRetry retryUnavailableReason } reviewDecision unresolvedReviewThreadCount createdAt body author { login avatarUrl url } assignees { login avatarUrl url } baseRefName headRefName state isDraft mergeable additions deletions changedFiles commitCount updatedAt mergedAt";

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
              item.id === pipeline.id ? pipeline : item,
            ),
          }
        : current,
    );
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
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-5">
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
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
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
        <div className="flex gap-2">
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

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader className="border-b">
              <h2 className="font-semibold">{t("description")}</h2>
            </CardHeader>
            <CardContent>
              {pullRequest.body ? (
                <div className="whitespace-pre-wrap text-sm leading-6">
                  {pullRequest.body}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("noDescription")}
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="gap-0 py-0">
            <CardHeader className="flex grid-cols-none flex-row items-center justify-between gap-3 border-b py-3">
              <div>
                <h2 className="font-semibold">{t("pipelines")}</h2>
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
                      <TableRow key={pipeline.id}>
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
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader className="border-b">
              <h2 className="font-semibold">{t("details")}</h2>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm">
                <DetailRow label={t("branches")}>
                  <span className="font-mono text-xs">
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

          <Card>
            <CardHeader className="border-b">
              <h2 className="font-semibold">{t("people")}</h2>
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

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
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
