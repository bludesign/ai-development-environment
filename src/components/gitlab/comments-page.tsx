"use client";

import {
  ExternalLink,
  Grid2X2,
  List,
  MessageSquareText,
  RefreshCw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { SearchableSelect } from "@/components/common/searchable-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  readIntegrationConfiguration,
  subscribeIntegrationConfiguration,
} from "@/lib/integration-configuration";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightBackgroundClasses,
  worktreeHighlightInsetAccentClasses,
} from "@/lib/worktree-highlight";
import type {
  GitLabCommentPageView,
  GitLabCommentThreadView,
  GitLabDiscussionView,
  GitLabMergeRequestView,
} from "@/services/gitlab";

import {
  GitLabCommentAuthor,
  GitLabCommentThreadCard,
  gitLabDiscussionState,
} from "./comment-thread-card";
import {
  gitLabCommentsHref,
  gitLabMergeRequestKey,
} from "./merge-request-links";
import { gitLabMergeRequestHref } from "./merge-request-status";

const LAYOUT_KEY = "gitlab-comments-layout";
const ALL_REQUESTS = "__all_merge_requests__";
const USER_FIELDS = "id username name avatarUrl webUrl";
const REQUEST_FIELDS = `id projectId iid projectPath title webUrl state draft sourceBranch targetBranch sha worktreeId worktreeHighlightColor author { ${USER_FIELDS} }`;
const DISCUSSION_FIELDS = `id individualNote notes { id body createdAt updatedAt system resolvable resolved webUrl filePath oldLine newLine author { ${USER_FIELDS} } resolvedBy { ${USER_FIELDS} } }`;
const COMMENTS_QUERY = `query GitLabComments($projectId: ID, $iid: Int, $discussionId: ID, $after: String, $first: Int!, $refresh: Boolean) {
  gitlabComments(projectId: $projectId, iid: $iid, discussionId: $discussionId, after: $after, first: $first, refresh: $refresh) {
    viewerId viewerUsername endCursor hasNextPage partial warnings
    mergeRequests { ${REQUEST_FIELDS} }
    threads { id mergeRequest { ${REQUEST_FIELDS} } discussion { ${DISCUSSION_FIELDS} } }
  }
}`;

type Selection = {
  projectId: string;
  iid: number;
  discussionId?: string | null;
};
function selectionFromValues(
  projectId?: string | null,
  iid?: number | null,
  discussionId?: string | null,
): Selection | null {
  return projectId &&
    iid &&
    Number.isInteger(iid) &&
    iid > 0 &&
    iid <= 2_147_483_647
    ? { projectId, iid, discussionId: discussionId || null }
    : null;
}
function unionRequests(
  previous: GitLabMergeRequestView[],
  next: GitLabMergeRequestView[],
) {
  return [
    ...new Map(
      [...previous, ...next].map((mr) => [gitLabMergeRequestKey(mr), mr]),
    ).values(),
  ];
}

export function GitLabCommentsPage({
  initialProjectId,
  initialIid,
  initialDiscussionId,
}: {
  initialProjectId?: string | null;
  initialIid?: number | null;
  initialDiscussionId?: string | null;
}) {
  const t = useTranslations("gitlabComments");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  const [configurationAttempt, setConfigurationAttempt] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(() =>
    selectionFromValues(initialProjectId, initialIid, initialDiscussionId),
  );
  const scope = JSON.stringify(selection);
  const [data, setData] = useState<{
    scope: string;
    page: GitLabCommentPageView;
  } | null>(null);
  const page = data?.scope === scope ? data.page : null;
  const [mergeRequests, setMergeRequests] = useState<GitLabMergeRequestView[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState(true);
  const [otherUsers, setOtherUsers] = useState(true);
  const [unresolved, setUnresolved] = useState(false);
  const [layout, setLayout] = useState<"cards" | "table">("cards");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [busyThreads, setBusyThreads] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const cursor = useRef<string | null>(null);
  const reloadAfterAction = useRef(false);
  const refreshAfterAction = useRef(false);
  const initialScope = JSON.stringify([
    initialProjectId,
    initialIid,
    initialDiscussionId,
  ]);
  const previousInitialScope = useRef(initialScope);
  const cancelLoad = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    generation.current++;
  }, []);

  useEffect(() => {
    mounted.current = true;
    let configurationController: AbortController | null = null;
    const load = async () => {
      configurationController?.abort();
      const current = new AbortController();
      configurationController = current;
      try {
        const result = await readIntegrationConfiguration<{
          gitlabSettings: { configured: boolean };
        }>(
          "gitlab",
          "query GitLabCommentsConfiguration { gitlabSettings { configured } }",
          { signal: current.signal },
        );
        if (current.signal.aborted) return;
        setConfigured(result.gitlabSettings.configured);
        setConfigurationError(null);
        setRevision((value) => value + 1);
      } catch (value) {
        if (!current.signal.aborted)
          setConfigurationError(
            value instanceof Error ? value.message : String(value),
          );
      }
    };
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem(LAYOUT_KEY);
      if (saved === "cards" || saved === "table") setLayout(saved);
      void load();
    }, 0);
    const dispose = subscribeIntegrationConfiguration(
      "gitlab",
      () => void load(),
    );
    return () => {
      mounted.current = false;
      window.clearTimeout(timer);
      configurationController?.abort();
      cancelLoad();
      dispose();
    };
  }, [cancelLoad, configurationAttempt]);

  const load = useCallback(
    async (append = false, refresh = false) => {
      if (!configured) return;
      if (inFlight.current.size > 0) {
        reloadAfterAction.current = true;
        refreshAfterAction.current ||= refresh;
        return;
      }
      if (append && controller.current) return;
      refresh ||= refreshAfterAction.current;
      refreshAfterAction.current = false;
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      const version = ++generation.current;
      setLoading(true);
      try {
        const result = await controlPlaneRequest<{
          gitlabComments: GitLabCommentPageView;
        }>(
          COMMENTS_QUERY,
          {
            projectId: selection?.projectId ?? null,
            iid: selection?.iid ?? null,
            discussionId: selection?.discussionId ?? null,
            after: append ? cursor.current : null,
            first: 25,
            ...(refresh ? { refresh: true } : {}),
          },
          { signal: current.signal },
        );
        if (current.signal.aborted || version !== generation.current) return;
        const next = result.gitlabComments;
        cursor.current = next.endCursor;
        setMergeRequests((previous) =>
          unionRequests(previous, next.mergeRequests),
        );
        setData((previous) => ({
          scope,
          page:
            append && previous?.scope === scope
              ? {
                  ...next,
                  threads: [
                    ...new Map(
                      [...previous.page.threads, ...next.threads].map(
                        (thread) => [thread.id, thread],
                      ),
                    ).values(),
                  ].sort(
                    (a, b) =>
                      Date.parse(b.discussion.notes[0]?.createdAt ?? "") -
                        Date.parse(a.discussion.notes[0]?.createdAt ?? "") ||
                      a.id.localeCompare(b.id),
                  ),
                  mergeRequests: unionRequests(
                    previous.page.mergeRequests,
                    next.mergeRequests,
                  ),
                  partial: previous.page.partial || next.partial,
                  warnings: [
                    ...new Set([...previous.page.warnings, ...next.warnings]),
                  ],
                }
              : next,
        }));
        setError(null);
      } catch (value) {
        if (!current.signal.aborted && version === generation.current)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (version === generation.current) {
          setLoading(false);
          controller.current = null;
        }
      }
    },
    [configured, scope, selection],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      cancelLoad();
    };
  }, [cancelLoad, load, revision]);

  const select = useCallback((next: Selection | null, updateUrl = true) => {
    controller.current?.abort();
    controller.current = null;
    generation.current++;
    setSelection(next);
    setError(null);
    cursor.current = null;
    if (updateUrl) {
      const params = new URLSearchParams(window.location.search);
      for (const key of ["project", "iid", "discussion"]) params.delete(key);
      if (next) {
        params.set("project", next.projectId);
        params.set("iid", String(next.iid));
        if (next.discussionId) params.set("discussion", next.discussionId);
      }
      const query = params.toString();
      window.history.pushState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}`,
      );
    }
  }, []);

  useEffect(() => {
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      select(
        selectionFromValues(
          params.get("project"),
          Number(params.get("iid")),
          params.get("discussion"),
        ),
        false,
      );
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [select]);

  useEffect(() => {
    if (previousInitialScope.current === initialScope) return;
    previousInitialScope.current = initialScope;
    const timer = window.setTimeout(() => {
      select(
        selectionFromValues(initialProjectId, initialIid, initialDiscussionId),
        false,
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialProjectId, initialIid, initialDiscussionId, initialScope, select]);

  const requestOptions = useMemo(
    () => [
      { value: ALL_REQUESTS, label: t("allMergeRequests") },
      ...(selection &&
      !mergeRequests.some(
        (mr) => gitLabMergeRequestKey(mr) === gitLabMergeRequestKey(selection),
      )
        ? [
            {
              value: gitLabMergeRequestKey(selection),
              label: `${selection.projectId} !${selection.iid}`,
            },
          ]
        : []),
      ...mergeRequests.map((mr) => ({
        value: gitLabMergeRequestKey(mr),
        label: `!${mr.iid} ${mr.title}`,
        description: mr.projectPath ?? mr.projectId,
        keywords: `${mr.projectPath ?? mr.projectId} ${mr.iid} ${mr.title}`,
      })),
    ],
    [mergeRequests, selection, t],
  );
  const threads = (page?.threads ?? []).filter((thread) => {
    const root = thread.discussion.notes.find((note) => !note.system);
    if (!root) return false;
    if (root.author.id === page?.viewerId ? !currentUser : !otherUsers)
      return false;
    const state = gitLabDiscussionState(thread.discussion);
    return !unresolved || (state.resolvable && !state.resolved);
  });

  const mutate = async (
    thread: GitLabCommentThreadView,
    resolved?: boolean,
  ) => {
    const body = drafts[thread.id] ?? "";
    if (
      inFlight.current.has(thread.id) ||
      (resolved === undefined && !body.trim())
    )
      return;
    inFlight.current.add(thread.id);
    setBusyThreads(new Set(inFlight.current));
    setActionErrors((previous) => ({ ...previous, [thread.id]: "" }));
    controller.current?.abort();
    controller.current = null;
    generation.current++;
    setLoading(false);
    const field =
      resolved === undefined
        ? "replyToGitLabDiscussion"
        : "setGitLabDiscussionResolved";
    try {
      const result = await controlPlaneRequest<
        Record<string, GitLabDiscussionView>
      >(
        resolved === undefined
          ? `mutation ReplyToGitLabDiscussion($input: GitLabDiscussionInput!, $body: String!) { replyToGitLabDiscussion(input: $input, body: $body) { ${DISCUSSION_FIELDS} } }`
          : `mutation SetGitLabDiscussionResolved($input: GitLabDiscussionInput!, $resolved: Boolean!) { setGitLabDiscussionResolved(input: $input, resolved: $resolved) { ${DISCUSSION_FIELDS} } }`,
        {
          input: {
            projectId: thread.mergeRequest.projectId,
            iid: thread.mergeRequest.iid,
            discussionId: thread.discussion.id,
          },
          ...(resolved === undefined ? { body } : { resolved }),
        },
      );
      if (!mounted.current) return;
      setData((previous) =>
        previous
          ? {
              ...previous,
              page: {
                ...previous.page,
                threads: previous.page.threads.map((item) =>
                  item.id === thread.id
                    ? { ...item, discussion: result[field]! }
                    : item,
                ),
              },
            }
          : previous,
      );
      if (resolved === undefined)
        setDrafts((previous) =>
          previous[thread.id] === body
            ? { ...previous, [thread.id]: "" }
            : previous,
        );
    } catch (value) {
      if (mounted.current)
        setActionErrors((previous) => ({
          ...previous,
          [thread.id]: value instanceof Error ? value.message : String(value),
        }));
    } finally {
      inFlight.current.delete(thread.id);
      if (mounted.current) {
        setBusyThreads(new Set(inFlight.current));
        if (inFlight.current.size === 0 && reloadAfterAction.current) {
          reloadAfterAction.current = false;
          setRevision((value) => value + 1);
        }
      }
    }
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
            disabled={
              configured === false ||
              (configured === null && !configurationError) ||
              loading ||
              busyThreads.size > 0
            }
            onClick={() =>
              configured === null
                ? setConfigurationAttempt((value) => value + 1)
                : void load(false, true)
            }
            variant="outline"
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
          {!selection?.discussionId && (
            <ToggleGroup
              aria-label={t("layout")}
              value={layout}
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              onValueChange={(value) => {
                if (value === "cards" || value === "table") {
                  setLayout(value);
                  window.localStorage.setItem(LAYOUT_KEY, value);
                }
              }}
            >
              <ToggleGroupItem aria-label={t("cards")} value="cards">
                <Grid2X2 />
              </ToggleGroupItem>
              <ToggleGroupItem aria-label={t("table")} value="table">
                <List />
              </ToggleGroupItem>
            </ToggleGroup>
          )}
        </div>
      </div>
      {(configurationError || error) && (
        <Alert variant="destructive">
          <AlertDescription>{configurationError ?? error}</AlertDescription>
        </Alert>
      )}
      {configured === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loadingConfiguration")}
        </div>
      ) : !configured ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageSquareText />
            </EmptyMedia>
            <EmptyTitle>{t("credentialsRequired")}</EmptyTitle>
            <EmptyDescription>{t("credentialsDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button asChild>
            <Link href="/settings">{t("openSettings")}</Link>
          </Button>
        </Empty>
      ) : (
        <>
          <Card className="py-0">
            <CardContent className="flex flex-wrap items-center gap-5 py-4">
              <div className="min-w-64 flex-1">
                <SearchableSelect
                  ariaLabel={t("allMergeRequests")}
                  emptyMessage={t("noMergeRequestMatches")}
                  options={requestOptions}
                  placeholder={t("allMergeRequests")}
                  searchPlaceholder={t("searchMergeRequests")}
                  value={
                    selection ? gitLabMergeRequestKey(selection) : ALL_REQUESTS
                  }
                  onValueChange={(value) => {
                    if (value === ALL_REQUESTS) select(null);
                    else {
                      const mr = mergeRequests.find(
                        (item) => gitLabMergeRequestKey(item) === value,
                      );
                      if (mr) select({ projectId: mr.projectId, iid: mr.iid });
                    }
                  }}
                />
              </div>
              <div className="flex flex-wrap gap-5">
                {[
                  {
                    key: "currentUser",
                    value: currentUser,
                    change: setCurrentUser,
                  },
                  {
                    key: "otherUsers",
                    value: otherUsers,
                    change: setOtherUsers,
                  },
                  {
                    key: "unresolved",
                    value: unresolved,
                    change: setUnresolved,
                  },
                ].map((filter) => (
                  <div key={filter.key} className="flex items-center gap-2">
                    <Checkbox
                      id={`gitlab-comments-${filter.key}`}
                      checked={filter.value}
                      onCheckedChange={(value) => filter.change(value === true)}
                    />
                    <Label htmlFor={`gitlab-comments-${filter.key}`}>
                      {t(filter.key)}
                    </Label>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          {selection?.discussionId && (
            <Alert>
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {t("focusedDiscussion")}
                <Button
                  size="sm"
                  variant="link"
                  onClick={() => select({ ...selection, discussionId: null })}
                >
                  {t("showAllDiscussions")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {page?.partial && (
            <Alert>
              <AlertDescription>{t("partial")}</AlertDescription>
            </Alert>
          )}
          {page?.warnings.map((warning) => (
            <Alert key={warning}>
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}
          {!page && !error ? (
            <div
              role="status"
              className="flex items-center gap-2 py-10 text-sm text-muted-foreground"
            >
              <Spinner />
              {t("loading")}
            </div>
          ) : threads.length === 0 ? (
            !error &&
            !page?.hasNextPage && (
              <Empty className="border py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MessageSquareText />
                  </EmptyMedia>
                  <EmptyTitle>{t("empty")}</EmptyTitle>
                  <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
          ) : selection?.discussionId || layout === "cards" ? (
            <div className="space-y-5">
              {threads.map((thread) => (
                <GitLabCommentThreadCard
                  key={thread.id}
                  thread={thread}
                  draft={drafts[thread.id] ?? ""}
                  onDraftChange={(value) =>
                    setDrafts((previous) => ({
                      ...previous,
                      [thread.id]: value,
                    }))
                  }
                  busy={busyThreads.has(thread.id)}
                  error={actionErrors[thread.id]}
                  onReply={() => void mutate(thread)}
                  onResolvedChange={(resolved) => void mutate(thread, resolved)}
                />
              ))}
            </div>
          ) : (
            <Card className="gap-0 py-0">
              <CardHeader>
                <CardTitle>{t("reviewThreads")}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {t("threadCount", { count: threads.length })}
                </p>
              </CardHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    {[
                      "author",
                      "mergeRequest",
                      "comment",
                      "date",
                      "replies",
                      "gitlab",
                    ].map((key) => (
                      <TableHead key={key}>{t(key)}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {threads.map((thread) => {
                    const notes = thread.discussion.notes.filter(
                      (note) => !note.system,
                    );
                    const root = notes[0]!;
                    const highlight =
                      thread.mergeRequest.worktreeHighlightColor;
                    return (
                      <TableRow
                        key={thread.id}
                        className={cn(
                          highlight &&
                            worktreeHighlightBackgroundClasses[highlight],
                        )}
                      >
                        <TableCell
                          className={cn(
                            "min-w-40",
                            highlight &&
                              worktreeHighlightInsetAccentClasses[highlight],
                          )}
                        >
                          <GitLabCommentAuthor user={root.author} />
                        </TableCell>
                        <TableCell className="min-w-64 whitespace-normal">
                          <Link
                            className="font-semibold text-primary hover:underline"
                            href={gitLabMergeRequestHref(thread.mergeRequest)}
                          >
                            {thread.mergeRequest.projectPath ??
                              thread.mergeRequest.projectId}{" "}
                            !{thread.mergeRequest.iid}
                          </Link>
                          <p>{thread.mergeRequest.title}</p>
                        </TableCell>
                        <TableCell className="min-w-80 whitespace-pre-wrap">
                          <Link
                            className="hover:underline"
                            href={gitLabCommentsHref(
                              thread.mergeRequest,
                              thread.discussion.id,
                            )}
                          >
                            {root.body}
                          </Link>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <DateTime kind="relative" value={root.createdAt} />
                        </TableCell>
                        <TableCell>{notes.length - 1}</TableCell>
                        <TableCell>
                          <Button asChild size="icon-sm" variant="ghost">
                            <a
                              aria-label={t("openInGitLab")}
                              href={
                                root.webUrl ??
                                `${thread.mergeRequest.webUrl}#note_${root.id}`
                              }
                              rel="noreferrer"
                              target="_blank"
                            >
                              <ExternalLink />
                            </a>
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
          {page?.hasNextPage && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {t("moreAvailable")}
              </p>
              <Button
                disabled={loading || busyThreads.size > 0}
                onClick={() => void load(true)}
                variant="outline"
              >
                {loading && <Spinner />}
                {t("loadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
