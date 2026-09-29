"use client";

import { ExternalLink, Send } from "lucide-react";
import { useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightAccentClasses,
  worktreeHighlightBackgroundClasses,
} from "@/lib/worktree-highlight";
import type {
  GitLabCommentThreadView,
  GitLabDiscussionView,
  GitLabUserView,
} from "@/services/gitlab";

import { GitLabMarkdown } from "./markdown";
import { gitLabCommentsHref } from "./merge-request-links";
import {
  gitLabMergeRequestHref,
  gitLabStatusColors,
} from "./merge-request-status";

export function gitLabDiscussionState(discussion: GitLabDiscussionView) {
  const notes = discussion.notes.filter(
    (note) => !note.system && note.resolvable,
  );
  return {
    resolvable: notes.length > 0,
    resolved: notes.length > 0 && notes.every((note) => note.resolved),
  };
}

export function GitLabCommentAuthor({ user }: { user: GitLabUserView | null }) {
  const t = useTranslations("gitlabComments");
  if (!user) return <span>{t("unknownAuthor")}</span>;
  return (
    <a
      className="inline-flex min-w-0 items-center gap-2 hover:underline"
      href={user.webUrl}
      rel="noreferrer"
      target="_blank"
    >
      <Avatar className="size-6">
        <AvatarImage alt="" src={user.avatarUrl ?? undefined} />
        <AvatarFallback>
          {user.username.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">@{user.username}</span>
    </a>
  );
}

export function GitLabCommentThreadCard({
  thread,
  draft,
  onDraftChange,
  busy,
  error,
  onReply,
  onResolvedChange,
}: {
  thread: GitLabCommentThreadView;
  draft: string;
  onDraftChange: (value: string) => void;
  busy: boolean;
  error?: string;
  onReply: () => void;
  onResolvedChange: (resolved: boolean) => void;
}) {
  const t = useTranslations("gitlabComments");
  const notes = thread.discussion.notes.filter((note) => !note.system);
  const root = notes[0];
  if (!root) return null;
  const state = gitLabDiscussionState(thread.discussion);
  const highlight = thread.mergeRequest.worktreeHighlightColor;
  const noteUrl = (id: string, webUrl?: string | null) =>
    webUrl ?? `${thread.mergeRequest.webUrl}#note_${id}`;
  const line = root.newLine ?? root.oldLine;
  return (
    <Card
      id={`discussion-${thread.discussion.id}`}
      className={cn(
        "min-w-0",
        highlight && "border-l-4",
        highlight && worktreeHighlightBackgroundClasses[highlight],
        highlight && worktreeHighlightAccentClasses[highlight],
      )}
    >
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <GitLabCommentAuthor user={root.author} />
              <DateTime
                className="text-muted-foreground"
                kind="relative"
                value={root.createdAt}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {root.filePath && (
                <Badge variant="outline">
                  {root.filePath}
                  {line != null ? ` · L${line}` : ` · ${t("fileComment")}`}
                </Badge>
              )}
              <Badge
                className={
                  state.resolvable
                    ? state.resolved
                      ? gitLabStatusColors.success
                      : gitLabStatusColors.warning
                    : gitLabStatusColors.neutral
                }
              >
                {state.resolvable
                  ? t(state.resolved ? "resolved" : "unresolved")
                  : t("generalComment")}
              </Badge>
              <Link
                className="font-medium text-primary hover:underline"
                href={gitLabMergeRequestHref(thread.mergeRequest)}
              >
                {thread.mergeRequest.projectPath ??
                  thread.mergeRequest.projectId}{" "}
                !{thread.mergeRequest.iid}
              </Link>
              <Link
                className="text-primary hover:underline"
                href={gitLabCommentsHref(
                  thread.mergeRequest,
                  thread.discussion.id,
                )}
              >
                {t("openDiscussion")}
              </Link>
            </div>
            <p className="text-sm font-medium">{thread.mergeRequest.title}</p>
          </div>
          <Button asChild size="icon-sm" variant="ghost">
            <a
              aria-label={t("openInGitLab")}
              href={noteUrl(root.id, root.webUrl)}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink />
            </a>
          </Button>
        </div>
        <GitLabMarkdown body={root.body} actions />
        {notes.slice(1).map((note) => (
          <Card key={note.id} size="sm">
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <GitLabCommentAuthor user={note.author} />
                  <DateTime kind="relative" value={note.createdAt} />
                </div>
                <Button asChild size="icon-sm" variant="ghost">
                  <a
                    aria-label={t("openReplyInGitLab")}
                    href={noteUrl(note.id, note.webUrl)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLink />
                  </a>
                </Button>
              </div>
              <GitLabMarkdown body={note.body} actions />
            </CardContent>
          </Card>
        ))}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onReply();
          }}
        >
          <Textarea
            aria-label={t("reply")}
            placeholder={t("replyPlaceholder")}
            value={draft}
            disabled={busy}
            onChange={(event) => onDraftChange(event.target.value)}
          />
          <div className="flex flex-wrap justify-between gap-2">
            <Button disabled={busy || !draft.trim()} type="submit" size="sm">
              {busy ? <Spinner /> : <Send />}
              {t(busy ? "replying" : "sendReply")}
            </Button>
            {state.resolvable && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onResolvedChange(!state.resolved)}
              >
                {t(state.resolved ? "reopen" : "resolve")}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
