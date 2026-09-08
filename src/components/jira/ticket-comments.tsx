"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { DateTime } from "@/components/common/date-time";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  JiraTextInput,
  JiraTicketDetail,
  JiraCommentView,
  JiraActivityPage,
} from "@/services/jira/types";

import { JiraUser } from "./jira-user";
import { JiraRichTextBlock, JiraTextComposer } from "./rich-text";
import {
  JIRA_TICKET_DETAIL_FIELDS,
  JIRA_PERSON_FIELDS,
  JIRA_RICH_TEXT_FIELDS,
  JIRA_CACHE_FIELDS,
} from "./ticket-graphql";

async function olderComments(
  issueKey: string,
  offset: number,
  total: number,
  signal: AbortSignal,
) {
  const data = await controlPlaneRequest<{
    jiraTicketComments: JiraActivityPage<JiraCommentView>;
  }>(
    `query JiraTicketComments($issueKey: ID!, $limit: Int!, $offset: Int!, $snapshotTotal: Int) {
      jiraTicketComments(issueKey: $issueKey, limit: $limit, offset: $offset, snapshotTotal: $snapshotTotal) {
        items { id author { ${JIRA_PERSON_FIELDS} } body content { ${JIRA_RICH_TEXT_FIELDS} } createdAt updatedAt }
        total limit offset cache { ${JIRA_CACHE_FIELDS} }
      }
    }`,
    { issueKey, limit: 50, offset, snapshotTotal: total },
    { signal },
  );
  return data.jiraTicketComments;
}

function mergeComments(older: JiraCommentView[], newer: JiraCommentView[]) {
  return [
    ...new Map([...older, ...newer].map((item) => [item.id, item])).values(),
  ];
}

export function JiraTicketComments({
  onTicketChange,
  ticket,
}: {
  onTicketChange: (ticket: JiraTicketDetail) => void;
  ticket: JiraTicketDetail;
}) {
  const t = useTranslations("jiraTickets");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailText = useTranslations("jiraTicketDetail");
  const [snapshot, setSnapshot] = useState({
    key: ticket.key,
    comments: ticket.comments,
    total: ticket.commentsTotal ?? ticket.comments.length,
  });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadedWindow = useRef({
    key: ticket.key,
    count: ticket.comments.length,
  });
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const target =
      loadedWindow.current.key === ticket.key
        ? loadedWindow.current.count
        : ticket.comments.length;
    void (async () => {
      try {
        let comments = ticket.comments;
        const total = ticket.commentsTotal ?? comments.length;
        while (comments.length < target && comments.length < total) {
          const page = await olderComments(
            ticket.key,
            comments.length,
            total,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const merged = mergeComments(page.items, comments);
          if (merged.length === comments.length) break;
          comments = merged;
        }
        if (controller.signal.aborted) return;
        loadedWindow.current = { key: ticket.key, count: comments.length };
        setSnapshot({ key: ticket.key, comments, total });
        setError(null);
      } catch (value) {
        if (!controller.signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!controller.signal.aborted) setLoadingOlder(false);
      }
    })();
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [ticket]);

  const loadOlder = async () => {
    if (loadingOlder) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoadingOlder(true);
    try {
      const page = await olderComments(
        ticket.key,
        snapshot.comments.length,
        snapshot.total,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const comments = mergeComments(page.items, snapshot.comments);
      loadedWindow.current = { key: ticket.key, count: comments.length };
      setSnapshot({ key: ticket.key, comments, total: page.total });
      setError(null);
    } catch (value) {
      if (!controller.signal.aborted)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  };
  const comments =
    snapshot.key === ticket.key ? snapshot.comments : ticket.comments;
  const total =
    snapshot.key === ticket.key
      ? snapshot.total
      : (ticket.commentsTotal ?? ticket.comments.length);

  const addComment = async (content: JiraTextInput) => {
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        addJiraComment: JiraTicketDetail;
      }>(
        `mutation AddJiraComment($issueKey: ID!, $content: JiraTextInput!) {
          addJiraComment(issueKey: $issueKey, content: $content) {
            ${JIRA_TICKET_DETAIL_FIELDS}
          }
        }`,
        { issueKey: ticket.key, content },
      );
      onTicketChange(data.addJiraComment);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      throw value;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <h3 className="font-semibold">{t("comments", { count: total })}</h3>
      {comments.length < total && (
        <Button
          disabled={loadingOlder}
          onClick={() => void loadOlder()}
          variant="outline"
        >
          {loadingOlder && <Spinner />}
          {detailText("loadMore")}
        </Button>
      )}
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noComments")}</p>
      ) : (
        <ItemGroup className="gap-3">
          {comments.map((comment) => (
            <Item asChild key={comment.id} variant="outline">
              <article>
                <ItemContent className="@container/comment basis-full">
                  <JiraRichTextBlock
                    compactActionsMenu
                    content={comment.content}
                    controlsClassName="contents @md/comment:flex @md/comment:flex-wrap @md/comment:items-center @md/comment:justify-end @md/comment:gap-1"
                    header={
                      <ItemTitle>
                        <JiraUser
                          avatarUrl={comment.author?.avatarUrl ?? null}
                          name={comment.author?.displayName ?? t("unknownUser")}
                        />
                      </ItemTitle>
                    }
                    headerActions={
                      <DateTime
                        className="col-start-1 row-start-2 -mt-1 mr-auto shrink-0 text-xs text-muted-foreground"
                        value={comment.createdAt}
                      />
                    }
                    headerClassName="grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto] items-start gap-x-2 gap-y-0.5 border-b pb-2 @md/comment:flex @md/comment:flex-row @md/comment:items-center @md/comment:gap-2"
                    showFormatOverride={false}
                    value={comment.body}
                    viewActionsClassName="col-start-2 row-start-1 ml-auto @md/comment:ml-0"
                  />
                </ItemContent>
              </article>
            </Item>
          ))}
        </ItemGroup>
      )}
      <div className="border-t pt-4">
        <JiraTextComposer
          busy={busy}
          error={error}
          onSubmit={addComment}
          submitLabel={t("addComment")}
        />
      </div>
    </section>
  );
}
