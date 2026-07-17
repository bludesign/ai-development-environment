"use client";

import {
  AlertTriangle,
  ExternalLink,
  GitBranch,
  Maximize2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { JiraRichTextBlock } from "@/components/jira/rich-text";
import { JiraTicketActions } from "@/components/jira/ticket-actions";
import { JiraTicketComments } from "@/components/jira/ticket-comments";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { JiraTicketDetail } from "@/services/jira/types";
import { TicketWorktreeDialog } from "./ticket-worktree-dialog";
import { JIRA_TICKET_DETAIL_FIELDS } from "./ticket-graphql";

const PRIORITY_CLASSES: Record<string, string> = {
  highest: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  high: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  medium:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  lowest:
    "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
};

function displayDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function priorityClass(priority: string) {
  return PRIORITY_CLASSES[priority.trim().toLowerCase()];
}

export function JiraTicketDrawer({
  issueKey,
  onClose,
  onTicketChange,
}: {
  issueKey: string | null;
  onClose: () => void;
  onTicketChange?: (ticket: JiraTicketDetail) => void;
}) {
  const t = useTranslations("jiraTickets");
  const [ticket, setTicket] = useState<JiraTicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);

  useEffect(() => {
    if (!issueKey) {
      const timeout = window.setTimeout(() => setTicket(null), 0);
      return () => window.clearTimeout(timeout);
    }
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      try {
        const data = await controlPlaneRequest<{
          jiraTicket: JiraTicketDetail;
        }>(
          `query JiraTicket($issueKey: ID!) { jiraTicket(issueKey: $issueKey) { ${JIRA_TICKET_DETAIL_FIELDS} } }`,
          { issueKey },
        );
        setTicket(data.jiraTicket);
        setError(null);
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        setLoading(false);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [issueKey]);

  const ticketChanged = (next: JiraTicketDetail) => {
    setTicket(next);
    onTicketChange?.(next);
  };

  return (
    <>
      <Sheet
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        open={Boolean(issueKey)}
      >
        <SheetContent className="w-[min(48rem,95vw)] overflow-y-auto sm:max-w-3xl">
          <SheetHeader className="border-b pr-12">
            <SheetTitle>{ticket?.key ?? issueKey ?? t("ticket")}</SheetTitle>
            <SheetDescription>
              {ticket?.summary ?? t("loadingTicket")}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-6 px-4 pb-6">
            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                {t("loadingTicket")}
              </div>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {ticket && (
              <>
                {(ticket.cache.stale || ticket.commentsCache.stale) && (
                  <Alert className="border-amber-500/30 bg-amber-500/10">
                    <AlertTriangle />
                    <AlertDescription>{t("staleTicket")}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Badge>{ticket.status}</Badge>
                    {ticket.issueType && <Badge>{ticket.issueType}</Badge>}
                    {ticket.priority && (
                      <Badge className={priorityClass(ticket.priority)}>
                        {ticket.priority}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => setWorktreeDialogOpen(true)}
                      size="sm"
                      variant="outline"
                    >
                      <GitBranch /> {t("worktreeAction")}
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={`/jira/tickets/${encodeURIComponent(ticket.key)}`}
                      >
                        <Maximize2 /> {t("openFullDetails")}
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <a href={ticket.jiraUrl} rel="noreferrer" target="_blank">
                        <ExternalLink /> {t("openInJira")}
                      </a>
                    </Button>
                  </div>
                </div>
                <JiraTicketActions
                  onTicketChange={ticketChanged}
                  ticket={ticket}
                />
                <DetailGrid ticket={ticket} />
                <section>
                  <Card size="sm">
                    <CardContent>
                      <JiraRichTextBlock
                        content={ticket.descriptionContent}
                        header={
                          <h3 className="font-semibold">
                            {t("descriptionTitle")}
                          </h3>
                        }
                        headerClassName="border-b pb-2"
                        value={ticket.description}
                      />
                    </CardContent>
                  </Card>
                </section>
                {(ticket.labels.length > 0 ||
                  ticket.components.length > 0 ||
                  ticket.fixVersions.length > 0 ||
                  ticket.sprintNames.length > 0) && (
                  <section>
                    <h3 className="mb-2 font-semibold">
                      {t("classification")}
                    </h3>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      {ticket.labels.length > 0 && (
                        <div>
                          <dt className="text-muted-foreground">
                            {t("labels")}
                          </dt>
                          <dd className="mt-1 flex flex-wrap gap-1">
                            {ticket.labels.map((label) => (
                              <Badge key={label}>{label}</Badge>
                            ))}
                          </dd>
                        </div>
                      )}
                      {ticket.components.length > 0 && (
                        <NamedList
                          label={t("components")}
                          values={ticket.components.map((item) => item.name)}
                        />
                      )}
                      {ticket.fixVersions.length > 0 && (
                        <NamedList
                          label={t("fixVersions")}
                          values={ticket.fixVersions.map((item) => item.name)}
                        />
                      )}
                      {ticket.sprintNames.length > 0 && (
                        <NamedList
                          label={t("sprints")}
                          values={ticket.sprintNames}
                        />
                      )}
                    </dl>
                  </section>
                )}
                {(ticket.parent ||
                  ticket.subtasks.length > 0 ||
                  ticket.issueLinks.length > 0) && (
                  <section>
                    <h3 className="mb-2 font-semibold">{t("relatedIssues")}</h3>
                    <ItemGroup className="gap-2">
                      {[
                        ...(ticket.parent ? [ticket.parent] : []),
                        ...ticket.subtasks,
                        ...ticket.issueLinks,
                      ].map((link, index) => (
                        <Item
                          asChild
                          key={`${link.key}-${index}`}
                          variant="outline"
                        >
                          <Link
                            href={`/jira/tickets/${encodeURIComponent(link.key)}`}
                          >
                            <ItemContent>
                              <ItemTitle>
                                {link.key} · {link.summary}
                              </ItemTitle>
                              <ItemDescription>
                                {link.relationship}
                              </ItemDescription>
                            </ItemContent>
                            <ItemActions>
                              {link.status && <Badge>{link.status}</Badge>}
                            </ItemActions>
                          </Link>
                        </Item>
                      ))}
                    </ItemGroup>
                  </section>
                )}
                {ticket.attachments.length > 0 && (
                  <section>
                    <h3 className="mb-2 font-semibold">{t("attachments")}</h3>
                    <ItemGroup className="gap-2">
                      {ticket.attachments.map((attachment) => (
                        <Item asChild key={attachment.id} variant="outline">
                          <a
                            href={attachment.contentUrl ?? "#"}
                            rel="noreferrer"
                            target="_blank"
                          >
                            <ItemContent>
                              <ItemTitle>{attachment.filename}</ItemTitle>
                            </ItemContent>
                            <ItemActions className="text-xs text-muted-foreground">
                              {attachment.size
                                ? `${Math.round(attachment.size / 1024)} KB`
                                : ""}
                            </ItemActions>
                          </a>
                        </Item>
                      ))}
                    </ItemGroup>
                  </section>
                )}
                <JiraTicketComments
                  onTicketChange={ticketChanged}
                  ticket={ticket}
                />
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      {ticket && (
        <TicketWorktreeDialog
          issueKey={ticket.key}
          onOpenChange={setWorktreeDialogOpen}
          open={worktreeDialogOpen}
        />
      )}
    </>
  );
}

function DetailGrid({ ticket }: { ticket: JiraTicketDetail }) {
  const t = useTranslations("jiraTickets");
  const rows = [
    [t("assignee"), ticket.assignee ?? t("unassigned")],
    [t("reporter"), ticket.reporter?.displayName ?? "—"],
    [t("created"), displayDate(ticket.createdAt)],
    [t("updated"), displayDate(ticket.updatedAt)],
    [t("due"), displayDate(ticket.dueAt)],
    [t("resolved"), displayDate(ticket.resolvedAt)],
  ];
  return (
    <dl className="grid gap-3 rounded-lg bg-muted/50 p-4 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-0.5 font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function NamedList({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1">{values.join(", ")}</dd>
    </div>
  );
}
