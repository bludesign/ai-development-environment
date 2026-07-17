"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
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
      <h3 className="font-semibold">
        {t("comments", { count: ticket.comments.length })}
      </h3>
      {ticket.comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noComments")}</p>
      ) : (
        <ItemGroup className="gap-3">
          {ticket.comments.map((comment) => (
            <Item asChild key={comment.id} variant="outline">
              <article>
                <ItemContent className="@container/comment basis-full">
                  <JiraRichTextBlock
                    compactActionsMenu
                    content={comment.content}
                    controlsClassName="items-center"
                    header={
                      <ItemTitle>
                        {comment.author?.displayName ?? t("unknownUser")}
                      </ItemTitle>
                    }
                    headerActions={
                      <time className="mr-auto shrink-0 text-xs text-muted-foreground">
                        {displayDate(comment.createdAt)}
                      </time>
                    }
                    headerClassName="flex-col items-stretch border-b pb-2 @md/comment:flex-row @md/comment:items-center"
                    showFormatOverride={false}
                    value={comment.body}
                    viewActionsClassName="ml-auto"
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
