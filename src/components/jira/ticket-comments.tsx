"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  Item,
  ItemContent,
  ItemGroup,
  ItemHeader,
  ItemTitle,
} from "@/components/ui/item";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { JiraTextInput, JiraTicketDetail } from "@/services/jira/types";

import { JiraRichTextBlock, JiraTextComposer } from "./rich-text";
import { JIRA_TICKET_DETAIL_FIELDS } from "./ticket-graphql";

function displayDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
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
      <div>
        <h3 className="mb-2 font-semibold">
          {t("comments", { count: ticket.comments.length })}
        </h3>
        <JiraTextComposer
          busy={busy}
          error={error}
          onSubmit={addComment}
          submitLabel={t("addComment")}
        />
      </div>
      {ticket.comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noComments")}</p>
      ) : (
        <ItemGroup className="gap-3">
          {ticket.comments.map((comment) => (
            <Item asChild key={comment.id} variant="outline">
              <article>
                <ItemHeader>
                  <ItemTitle>
                    {comment.author?.displayName ?? t("unknownUser")}
                  </ItemTitle>
                  <time className="text-xs text-muted-foreground">
                    {displayDate(comment.createdAt)}
                  </time>
                </ItemHeader>
                <ItemContent className="basis-full">
                  <JiraRichTextBlock
                    content={comment.content}
                    value={comment.body}
                  />
                </ItemContent>
              </article>
            </Item>
          ))}
        </ItemGroup>
      )}
    </section>
  );
}
