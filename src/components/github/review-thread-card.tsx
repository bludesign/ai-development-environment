"use client";

import { ExternalLink, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useState } from "react";

import { GitHubMarkdownBlock } from "@/components/github/github-markdown";
import { pullRequestDetailHref } from "@/components/github/pull-request-links";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DateTime } from "@/components/common/date-time";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitHubPullRequestActor,
  GitHubReviewComment,
  GitHubReviewThread,
  GitHubReviewThreadState,
} from "@/services/github/types";

const COMMENT_FIELDS =
  "id body bodyText bodyHtml url author { login avatarUrl url } createdAt updatedAt";
const STATE_FIELDS =
  "id isResolved viewerCanResolve viewerCanUnresolve resolvedBy { login avatarUrl url }";

export function ReviewAuthor({
  actor,
  compact = false,
}: {
  actor: GitHubPullRequestActor | null;
  compact?: boolean;
}) {
  const t = useTranslations("githubComments");
  if (!actor) return <span>{t("unknownAuthor")}</span>;
  return (
    <a
      className="inline-flex min-w-0 items-center gap-2 hover:underline"
      href={actor.url}
      rel="noreferrer"
      target="_blank"
    >
      <Avatar className={compact ? "size-5" : "size-7"}>
        <AvatarImage alt="" src={actor.avatarUrl} />
        <AvatarFallback>{actor.login.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="truncate">@{actor.login}</span>
    </a>
  );
}

export function threadLocation(thread: GitHubReviewThread, fileLabel: string) {
  if (thread.subjectType === "FILE") return `${thread.path} · ${fileLabel}`;
  const end = thread.line ?? thread.originalLine;
  const start = thread.startLine ?? thread.originalStartLine;
  if (end === null) return thread.path;
  return `${thread.path} · L${start && start !== end ? `${start}–` : ""}${end}`;
}

export function ReviewThreadCard({
  onReplyAdded,
  onStateChanged,
  thread,
}: {
  onReplyAdded: (threadId: string, comment: GitHubReviewComment) => void;
  onStateChanged: (state: GitHubReviewThreadState) => void;
  thread: GitHubReviewThread;
}) {
  const t = useTranslations("githubComments");
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const [changingState, setChangingState] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitReply = async (event: FormEvent) => {
    event.preventDefault();
    if (!reply.trim() || !thread.viewerCanReply) return;
    setReplying(true);
    try {
      const data = await controlPlaneRequest<{
        replyToGitHubReviewThread: GitHubReviewComment;
      }>(
        `mutation ReplyToGitHubReviewThread($threadId: ID!, $body: String!) {
          replyToGitHubReviewThread(threadId: $threadId, body: $body) {
            ${COMMENT_FIELDS}
          }
        }`,
        { threadId: thread.id, body: reply },
      );
      onReplyAdded(thread.id, data.replyToGitHubReviewThread);
      setReply("");
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setReplying(false);
    }
  };

  const changeState = async () => {
    const resolved = !thread.isResolved;
    if (
      (resolved && !thread.viewerCanResolve) ||
      (!resolved && !thread.viewerCanUnresolve)
    ) {
      return;
    }
    setChangingState(true);
    try {
      const data = await controlPlaneRequest<{
        setGitHubReviewThreadResolved: GitHubReviewThreadState;
      }>(
        `mutation SetGitHubReviewThreadResolved(
          $threadId: ID!
          $resolved: Boolean!
        ) {
          setGitHubReviewThreadResolved(
            threadId: $threadId
            resolved: $resolved
          ) { ${STATE_FIELDS} }
        }`,
        { threadId: thread.id, resolved },
      );
      onStateChanged(data.setGitHubReviewThreadResolved);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setChangingState(false);
    }
  };

  const canChangeState = thread.isResolved
    ? thread.viewerCanUnresolve
    : thread.viewerCanResolve;

  return (
    <Card>
      <CardContent className="space-y-5">
        <GitHubMarkdownBlock
          body={thread.rootComment.body}
          bodyHtml={thread.rootComment.bodyHtml}
          emptyLabel="—"
          header={
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <ReviewAuthor actor={thread.rootComment.author} />
                <span className="text-muted-foreground">·</span>
                <DateTime
                  className="text-muted-foreground"
                  kind="relative"
                  value={thread.rootComment.createdAt}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  className="max-w-full"
                  title={threadLocation(thread, t("fileComment"))}
                  variant="outline"
                >
                  {threadLocation(thread, t("fileComment"))}
                </Badge>
                {thread.isOutdated && (
                  <Badge variant="secondary">{t("outdated")}</Badge>
                )}
                <Badge variant={thread.isResolved ? "secondary" : "outline"}>
                  {thread.isResolved ? t("resolved") : t("unresolved")}
                </Badge>
                <Link
                  className="font-medium text-primary hover:underline"
                  href={pullRequestDetailHref(thread.pullRequest)}
                >
                  {thread.pullRequest.repositoryNameWithOwner} #
                  {thread.pullRequest.number}
                </Link>
              </div>
            </div>
          }
          headerActions={
            <GitHubCommentLink
              label={t("openInGitHub")}
              url={thread.rootComment.url}
            />
          }
          headerClassName="border-b pb-4"
        />

        {thread.replies.length > 0 && (
          <div className="space-y-3">
            {thread.replies.map((comment) => (
              <Card key={comment.id} size="sm">
                <CardContent>
                  <GitHubMarkdownBlock
                    body={comment.body}
                    bodyHtml={comment.bodyHtml}
                    emptyLabel="—"
                    header={
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <ReviewAuthor actor={comment.author} compact />
                        <span className="text-muted-foreground">·</span>
                        <DateTime
                          className="text-muted-foreground"
                          kind="relative"
                          value={comment.createdAt}
                        />
                      </div>
                    }
                    headerActions={
                      <GitHubCommentLink
                        label={t("openReplyInGitHub")}
                        url={comment.url}
                      />
                    }
                    headerClassName="border-b pb-3"
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form className="space-y-3" onSubmit={submitReply}>
          <Textarea
            aria-label={t("reply")}
            disabled={!thread.viewerCanReply || replying}
            onChange={(event) => setReply(event.target.value)}
            placeholder={
              thread.viewerCanReply
                ? t("replyPlaceholder")
                : t("replyUnavailable")
            }
            value={reply}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              disabled={!canChangeState || changingState}
              onClick={() => void changeState()}
              type="button"
              variant="outline"
            >
              {changingState && <Spinner />}
              {thread.isResolved ? t("reopen") : t("resolve")}
            </Button>
            <Button
              disabled={!thread.viewerCanReply || replying || !reply.trim()}
              type="submit"
            >
              {replying ? <Spinner /> : <Send />}
              {replying ? t("replying") : t("sendReply")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function GitHubCommentLink({ label, url }: { label: string; url: string }) {
  return (
    <Button asChild size="icon-xs" title={label} variant="outline">
      <a aria-label={label} href={url} rel="noreferrer" target="_blank">
        <ExternalLink />
      </a>
    </Button>
  );
}
