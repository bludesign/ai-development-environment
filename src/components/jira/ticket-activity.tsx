"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  JiraActivityPage,
  JiraTicketDetail,
  JiraWorklog,
} from "@/services/jira/types";

import { JiraRichTextBlock } from "./rich-text";
import { JiraTicketComments } from "./ticket-comments";
import type { JiraTicketHistoryState } from "./ticket-history";
import { JiraUser } from "./jira-user";
import {
  JIRA_CACHE_FIELDS,
  JIRA_PERSON_FIELDS,
  JIRA_RICH_TEXT_FIELDS,
} from "./ticket-graphql";

const PAGE_SIZE = 50;

function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

export function JiraTicketActivity({
  history,
  onTicketChange,
  ticket,
  title,
}: {
  history: JiraTicketHistoryState;
  onTicketChange: (ticket: JiraTicketDetail) => void;
  ticket: JiraTicketDetail;
  title: string;
}) {
  const t = useTranslations("jiraTicketDetail");
  const [worklogs, setWorklogs] = useState<JiraWorklog[]>([]);
  const [worklogTotal, setWorklogTotal] = useState<number | null>(null);
  const [worklogLoading, setWorklogLoading] = useState(false);
  const [worklogError, setWorklogError] = useState<string | null>(null);

  const loadWorklogs = async () => {
    if (worklogLoading) return;
    setWorklogLoading(true);
    setWorklogError(null);
    try {
      const data = await controlPlaneRequest<{
        jiraTicketWorklogs: JiraActivityPage<JiraWorklog>;
      }>(
        `query JiraTicketWorklogs($issueKey: ID!, $limit: Int!, $offset: Int!) {
          jiraTicketWorklogs(issueKey: $issueKey, limit: $limit, offset: $offset) {
            items {
              id author { ${JIRA_PERSON_FIELDS} }
              comment { ${JIRA_RICH_TEXT_FIELDS} }
              timeSpent timeSpentSeconds startedAt createdAt updatedAt
            }
            total limit offset cache { ${JIRA_CACHE_FIELDS} }
          }
        }`,
        { issueKey: ticket.key, limit: PAGE_SIZE, offset: worklogs.length },
      );
      setWorklogs((current) => [...current, ...data.jiraTicketWorklogs.items]);
      setWorklogTotal(data.jiraTicketWorklogs.total);
    } catch (value) {
      setWorklogError(value instanceof Error ? value.message : String(value));
    } finally {
      setWorklogLoading(false);
    }
  };

  return (
    <Tabs
      defaultValue="comments"
      onValueChange={(value) => {
        if (value === "history" && history.total === null) void history.load();
        if (value === "worklogs" && worklogTotal === null) void loadWorklogs();
      }}
    >
      <Card>
        <CardHeader className="flex grid-cols-none flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>{title}</CardTitle>
          <TabsList className="ml-auto">
            <TabsTrigger value="comments">{t("comments")}</TabsTrigger>
            <TabsTrigger value="history">{t("history")}</TabsTrigger>
            <TabsTrigger value="worklogs">{t("worklogs")}</TabsTrigger>
          </TabsList>
        </CardHeader>
        <CardContent>
          <TabsContent value="comments">
            <JiraTicketComments
              onTicketChange={onTicketChange}
              ticket={ticket}
            />
          </TabsContent>
          <TabsContent className="space-y-3" value="history">
            {history.error && (
              <Alert variant="destructive">
                <AlertDescription>{history.error}</AlertDescription>
              </Alert>
            )}
            {history.changes.map((change) => (
              <Card key={change.id} size="sm">
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                    <JiraUser
                      avatarUrl={change.author?.avatarUrl ?? null}
                      name={change.author?.displayName ?? t("unknownUser")}
                    />
                    <time>{date(change.createdAt)}</time>
                  </div>
                  <ul className="space-y-1 text-sm">
                    {change.items.map((item, index) => (
                      <li
                        key={`${change.id}-${item.fieldId ?? item.field}-${index}`}
                      >
                        <span className="font-medium">{item.field}</span>:{" "}
                        {item.from ?? "—"} → {item.to ?? "—"}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
            {history.loading && <Spinner />}
            {history.total === 0 && (
              <p className="text-sm text-muted-foreground">{t("noHistory")}</p>
            )}
            {history.total !== null &&
              history.changes.length < history.total && (
                <Button
                  disabled={history.loading}
                  onClick={() => void history.load()}
                  variant="outline"
                >
                  {t("loadMore")}
                </Button>
              )}
          </TabsContent>
          <TabsContent className="space-y-3" value="worklogs">
            {worklogError && (
              <Alert variant="destructive">
                <AlertDescription>{worklogError}</AlertDescription>
              </Alert>
            )}
            {worklogs.map((worklog) => (
              <Card key={worklog.id} size="sm">
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap justify-between gap-2">
                    <JiraUser
                      avatarUrl={worklog.author?.avatarUrl ?? null}
                      className="font-medium"
                      name={worklog.author?.displayName ?? t("unknownUser")}
                    />
                    <span className="text-sm">{worklog.timeSpent ?? "—"}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("started", { date: date(worklog.startedAt) })}
                  </p>
                  {worklog.comment && (
                    <JiraRichTextBlock
                      content={worklog.comment}
                      value={worklog.comment.raw}
                    />
                  )}
                </CardContent>
              </Card>
            ))}
            {worklogLoading && <Spinner />}
            {worklogTotal === 0 && (
              <p className="text-sm text-muted-foreground">{t("noWorklogs")}</p>
            )}
            {worklogTotal !== null && worklogs.length < worklogTotal && (
              <Button
                disabled={worklogLoading}
                onClick={() => void loadWorklogs()}
                variant="outline"
              >
                {t("loadMore")}
              </Button>
            )}
          </TabsContent>
        </CardContent>
      </Card>
    </Tabs>
  );
}
