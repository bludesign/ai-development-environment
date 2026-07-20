"use client";

import {
  ExternalLink,
  Grid2X2,
  List,
  MessageSquareText,
  RefreshCw,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  pullRequestDetailHref,
  pullRequestKey,
} from "@/components/github/pull-request-links";
import {
  relativeAge,
  ReviewAuthor,
  ReviewThreadCard,
} from "@/components/github/review-thread-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitHubReviewComment,
  GitHubReviewThread,
  GitHubReviewThreadPage,
  GitHubReviewThreadState,
  GitHubSettingsView,
} from "@/services/github/types";

const LAYOUT_KEY = "github-comments-layout";
const ALL_PULL_REQUESTS = "__all_pull_requests__";
const THREAD_FIELDS = `
  id isResolved isOutdated subjectType path line startLine originalLine originalStartLine
  viewerCanReply viewerCanResolve viewerCanUnresolve
  resolvedBy { login avatarUrl url }
  pullRequest { id number title url repositoryNameWithOwner }
  rootComment { id body bodyText bodyHtml url author { login avatarUrl url } createdAt updatedAt }
  replies { id body bodyText bodyHtml url author { login avatarUrl url } createdAt updatedAt }
`;

function replacePullRequestParam(value: string | null, push = true) {
  const params = new URLSearchParams(window.location.search);
  if (value) params.set("pullRequest", value);
  else params.delete("pullRequest");
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

export function CommentsPage({
  initialPullRequest = null,
}: {
  initialPullRequest?: string | null;
}) {
  const t = useTranslations("githubComments");
  const locale = useLocale();
  const [settings, setSettings] = useState<GitHubSettingsView | null>(null);
  const [page, setPage] = useState<GitHubReviewThreadPage | null>(null);
  const [configurationLoading, setConfigurationLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPullRequest, setSelectedPullRequest] = useState(
    initialPullRequest ?? "",
  );
  const [currentUser, setCurrentUser] = useState(true);
  const [otherUsers, setOtherUsers] = useState(true);
  const [unresolved, setUnresolved] = useState(true);
  const [layout, setLayout] = useState<"cards" | "table">("cards");

  const loadConfiguration = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        githubSettings: GitHubSettingsView;
      }>(
        "query GitHubCommentsConfiguration { githubSettings { tokenConfigured updatedAt } }",
      );
      setSettings(data.githubSettings);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setConfigurationLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        githubReviewThreads: GitHubReviewThreadPage;
      }>(`query GitHubReviewThreads {
        githubReviewThreads {
          viewerLogin
          truncated
          pullRequests { id number title url repositoryNameWithOwner }
          threads { ${THREAD_FIELDS} }
        }
      }`);
      setPage(data.githubReviewThreads);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadConfiguration(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadConfiguration]);

  useEffect(() => {
    const savedLayout = window.localStorage.getItem(LAYOUT_KEY);
    if (savedLayout !== "cards" && savedLayout !== "table") return;
    const timeout = window.setTimeout(() => setLayout(savedLayout), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!settings?.tokenConfigured || page || loading) return;
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load, loading, page, settings?.tokenConfigured]);

  useEffect(() => {
    const syncFromUrl = () =>
      setSelectedPullRequest(
        new URLSearchParams(window.location.search).get("pullRequest") ?? "",
      );
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  useEffect(() => {
    if (
      !page ||
      !selectedPullRequest ||
      page.pullRequests.some(
        (pullRequest) => pullRequestKey(pullRequest) === selectedPullRequest,
      )
    ) {
      return;
    }
    replacePullRequestParam(null, false);
  }, [page, selectedPullRequest]);

  const validSelectedPullRequest =
    selectedPullRequest &&
    page?.pullRequests.some(
      (pullRequest) => pullRequestKey(pullRequest) === selectedPullRequest,
    )
      ? selectedPullRequest
      : "";

  const pullRequestOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_PULL_REQUESTS, label: t("allPullRequests") },
      ...(page?.pullRequests.map((pullRequest) => ({
        value: pullRequestKey(pullRequest),
        label: `#${pullRequest.number} ${pullRequest.title}`,
        description: pullRequest.repositoryNameWithOwner,
        keywords: `${pullRequest.repositoryNameWithOwner} ${pullRequest.number} ${pullRequest.title}`,
      })) ?? []),
    ],
    [page?.pullRequests, t],
  );

  const filteredThreads = useMemo(() => {
    if (!page || (!currentUser && !otherUsers)) return [];
    const viewer = page.viewerLogin.toLowerCase();
    return page.threads.filter((thread) => {
      if (
        validSelectedPullRequest &&
        pullRequestKey(thread.pullRequest) !== validSelectedPullRequest
      ) {
        return false;
      }
      const byCurrentUser =
        thread.rootComment.author?.login.toLowerCase() === viewer;
      if (byCurrentUser ? !currentUser : !otherUsers) return false;
      return !unresolved || !thread.isResolved;
    });
  }, [currentUser, otherUsers, page, unresolved, validSelectedPullRequest]);

  const replyAdded = (threadId: string, comment: GitHubReviewComment) => {
    setPage((current) =>
      current
        ? {
            ...current,
            threads: current.threads.map((thread) =>
              thread.id === threadId
                ? { ...thread, replies: [...thread.replies, comment] }
                : thread,
            ),
          }
        : current,
    );
  };

  const stateChanged = (state: GitHubReviewThreadState) => {
    setPage((current) =>
      current
        ? {
            ...current,
            threads: current.threads.map((thread) =>
              thread.id === state.id ? { ...thread, ...state } : thread,
            ),
          }
        : current,
    );
  };

  const selectPullRequest = (value: string) => {
    const next = value === ALL_PULL_REQUESTS ? "" : value;
    setSelectedPullRequest(next);
    replacePullRequestParam(next || null);
  };

  const setLayoutAndRemember = (value: "cards" | "table") => {
    setLayout(value);
    window.localStorage.setItem(LAYOUT_KEY, value);
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
        <div className="flex items-center gap-2">
          <Button
            disabled={!settings?.tokenConfigured || loading}
            onClick={() => void load()}
            variant="outline"
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
          <ToggleGroup
            aria-label={t("layout")}
            onValueChange={(value) => {
              if (value === "cards" || value === "table") {
                setLayoutAndRemember(value);
              }
            }}
            size="sm"
            spacing={0}
            type="single"
            value={layout}
            variant="outline"
          >
            <ToggleGroupItem aria-label={t("cards")} value="cards">
              <Grid2X2 />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label={t("table")} value="table">
              <List />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {configurationLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loadingConfiguration")}
        </div>
      ) : !settings?.tokenConfigured ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageSquareText />
            </EmptyMedia>
            <EmptyTitle>{t("credentialsRequired")}</EmptyTitle>
            <EmptyDescription>{t("credentialsDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button asChild className="mt-4">
            <Link href="/settings">{t("openSettings")}</Link>
          </Button>
        </Empty>
      ) : (
        <>
          <Card className="py-0">
            <CardContent className="flex flex-wrap items-center gap-5 py-4">
              <div className="min-w-64 flex-1">
                <SearchableSelect
                  ariaLabel={t("allPullRequests")}
                  emptyMessage={t("noPullRequestMatches")}
                  onValueChange={selectPullRequest}
                  options={pullRequestOptions}
                  placeholder={t("allPullRequests")}
                  searchPlaceholder={t("searchPullRequests")}
                  value={validSelectedPullRequest || ALL_PULL_REQUESTS}
                />
              </div>
              <div className="flex flex-wrap gap-5">
                <FilterCheckbox
                  checked={currentUser}
                  id="comments-current-user"
                  label={t("currentUser")}
                  onCheckedChange={setCurrentUser}
                />
                <FilterCheckbox
                  checked={otherUsers}
                  id="comments-other-users"
                  label={t("otherUsers")}
                  onCheckedChange={setOtherUsers}
                />
                <FilterCheckbox
                  checked={unresolved}
                  id="comments-unresolved"
                  label={t("unresolved")}
                  onCheckedChange={setUnresolved}
                />
              </div>
            </CardContent>
          </Card>

          {page?.truncated && (
            <Alert>
              <AlertDescription>{t("truncated")}</AlertDescription>
            </Alert>
          )}

          {loading && !page ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Spinner /> {t("loading")}
            </div>
          ) : layout === "cards" ? (
            filteredThreads.length === 0 ? (
              <ReviewThreadsEmpty />
            ) : (
              <div className="space-y-5">
                {filteredThreads.map((thread) => (
                  <ReviewThreadCard
                    key={thread.id}
                    locale={locale}
                    onReplyAdded={replyAdded}
                    onStateChanged={stateChanged}
                    thread={thread}
                  />
                ))}
              </div>
            )
          ) : (
            <ReviewThreadTable locale={locale} threads={filteredThreads} />
          )}
        </>
      )}
    </section>
  );
}

function ReviewThreadsEmpty({ className }: { className?: string }) {
  const t = useTranslations("githubComments");
  return (
    <Empty className={className ?? "border py-12"}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageSquareText />
        </EmptyMedia>
        <EmptyTitle>{t("empty")}</EmptyTitle>
        <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function FilterCheckbox({
  checked,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        checked={checked}
        id={id}
        onCheckedChange={(value) => onCheckedChange(Boolean(value))}
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

function ReviewThreadTable({
  locale,
  threads,
}: {
  locale: string;
  threads: GitHubReviewThread[];
}) {
  const t = useTranslations("githubComments");
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>{t("reviewThreads")}</CardTitle>
        <CardDescription>
          {t("reviewThreadsDescription", { count: threads.length })}
        </CardDescription>
      </CardHeader>
      {threads.length === 0 ? (
        <ReviewThreadsEmpty className="border-0 py-12" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t("author")}</TableHead>
              <TableHead>{t("pullRequest")}</TableHead>
              <TableHead>{t("comment")}</TableHead>
              <TableHead>{t("date")}</TableHead>
              <TableHead>{t("replies")}</TableHead>
              <TableHead className="text-right">{t("github")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {threads.map((thread) => (
              <TableRow key={thread.id}>
                <TableCell className="min-w-40">
                  <ReviewAuthor actor={thread.rootComment.author} compact />
                </TableCell>
                <TableCell className="min-w-64 whitespace-normal">
                  <div className="flex flex-col">
                    <Link
                      className="font-semibold text-primary hover:underline"
                      href={pullRequestDetailHref(thread.pullRequest)}
                    >
                      {thread.pullRequest.repositoryNameWithOwner} #
                      {thread.pullRequest.number}
                    </Link>
                    <Link
                      className="text-sm hover:underline"
                      href={pullRequestDetailHref(thread.pullRequest)}
                    >
                      {thread.pullRequest.title}
                    </Link>
                  </div>
                </TableCell>
                <TableCell className="min-w-80 whitespace-pre-wrap">
                  {thread.rootComment.bodyText}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <time dateTime={thread.rootComment.createdAt}>
                    {relativeAge(thread.rootComment.createdAt, locale)}
                  </time>
                </TableCell>
                <TableCell>{thread.replies.length}</TableCell>
                <TableCell className="text-right">
                  <Button asChild size="icon-sm" variant="ghost">
                    <a
                      aria-label={t("openInGitHub")}
                      href={thread.rootComment.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <ExternalLink />
                    </a>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
