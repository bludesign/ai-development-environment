"use client";

import {
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { JiraUser } from "@/components/jira/jira-user";
import { JiraDescriptionHistory } from "@/components/jira/description-history";
import {
  JiraRichTextBlock,
  JiraTextComposer,
} from "@/components/jira/rich-text";
import { JiraTicketActions } from "@/components/jira/ticket-actions";
import { JiraTicketActivity } from "@/components/jira/ticket-activity";
import { TicketWorktreeDialog } from "@/components/jira/ticket-worktree-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DateTime } from "@/components/ui/date-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { formatDateValue } from "@/lib/date-format";
import type {
  JiraEditField,
  JiraNamedValue,
  JiraTextInput,
  JiraTicketDetail,
  JiraTicketField,
  UpdateJiraTicketInput,
} from "@/services/jira/types";

import { JIRA_TICKET_DETAIL_FIELDS } from "./ticket-graphql";
import { useJiraTicketHistory } from "./ticket-history";

function parseDateOnly(value: string): Date | undefined {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

function toDateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function JiraTicketDetailPage({ issueKey }: { issueKey: string }) {
  const t = useTranslations("jiraTicketDetail");
  const tt = useTranslations("jiraTickets");
  const ticketHistory = useJiraTicketHistory(issueKey);
  const [ticket, setTicket] = useState<JiraTicketDetail | null>(null);
  const [editFields, setEditFields] = useState<JiraEditField[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summary, setSummary] = useState("");
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [fieldSearch, setFieldSearch] = useState("");
  const [fieldsOpen, setFieldsOpen] = useState(false);

  const loadEditFields = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        jiraTicketEditFields: JiraEditField[];
      }>(
        `query JiraTicketEditFields($issueKey: ID!) {
          jiraTicketEditFields(issueKey: $issueKey) {
            id name required schemaType allowedValues { id name }
          }
        }`,
        { issueKey },
      );
      setEditFields(data.jiraTicketEditFields);
    } catch {
      setEditFields([]);
    }
  }, [issueKey]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{ jiraTicket: JiraTicketDetail }>(
        `query JiraTicketDetail($issueKey: ID!) {
          jiraTicket(issueKey: $issueKey) { ${JIRA_TICKET_DETAIL_FIELDS} }
        }`,
        { issueKey },
      );
      setTicket(data.jiraTicket);
      setSummary(data.jiraTicket.summary);
      setError(null);
      await loadEditFields();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [issueKey, loadEditFields]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const ticketChanged = (next: JiraTicketDetail) => {
    setTicket(next);
    setSummary(next.summary);
    setError(null);
    ticketHistory.reset();
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        refreshJiraCachedTicket: JiraTicketDetail;
      }>(
        `mutation RefreshJiraTicket($issueKey: ID!) {
          refreshJiraCachedTicket(issueKey: $issueKey) {
            ${JIRA_TICKET_DETAIL_FIELDS}
          }
        }`,
        { issueKey },
      );
      ticketChanged(data.refreshJiraCachedTicket);
      await loadEditFields();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const update = async (input: Omit<UpdateJiraTicketInput, "issueKey">) => {
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        updateJiraTicket: JiraTicketDetail;
      }>(
        `mutation UpdateJiraTicket($input: UpdateJiraTicketInput!) {
          updateJiraTicket(input: $input) { ${JIRA_TICKET_DETAIL_FIELDS} }
        }`,
        { input: { issueKey, ...input } },
      );
      ticketChanged(data.updateJiraTicket);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      throw value;
    } finally {
      setBusy(false);
    }
  };

  if (loading && !ticket) {
    return (
      <div className="mx-auto flex w-full max-w-6xl items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {t("loading")}
      </div>
    );
  }

  if (!ticket) {
    return (
      <section className="mx-auto w-full max-w-5xl space-y-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyTitle>{t("notFound")}</EmptyTitle>
            <EmptyDescription>{t("notFoundDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button asChild className="mt-4" variant="outline">
            <Link href="/jira/tickets">{t("back")}</Link>
          </Button>
        </Empty>
      </section>
    );
  }

  const editable = new Set(editFields.map((field) => field.id));
  const descriptionField = editFields.find(
    (field) => field.id === "description",
  );
  const filteredFields = ticket.allFields.filter((field) =>
    `${field.name} ${field.id}`
      .toLowerCase()
      .includes(fieldSearch.toLowerCase()),
  );
  const relatedIssues = [
    ...(ticket.parent ? [ticket.parent] : []),
    ...ticket.subtasks,
    ...ticket.issueLinks,
  ];

  const saveSummary = async (event: FormEvent) => {
    event.preventDefault();
    await update({ summary });
    setSummaryEditing(false);
  };

  const saveDescription = async (description: JiraTextInput) => {
    await update({
      description: description.value.trim() ? description : null,
    });
    setDescriptionEditing(false);
  };

  return (
    <section className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Button asChild className="mb-3 -ml-2" variant="ghost">
            <Link href="/jira/tickets">
              <ArrowLeft /> {t("back")}
            </Link>
          </Button>
          <p className="text-sm text-muted-foreground">{ticket.key}</p>
          {summaryEditing ? (
            <form className="mt-1 flex max-w-3xl gap-2" onSubmit={saveSummary}>
              <Input
                aria-label={t("summary")}
                autoFocus
                disabled={busy}
                onChange={(event) => setSummary(event.target.value)}
                value={summary}
              />
              <Button disabled={busy || !summary.trim()} type="submit">
                {t("save")}
              </Button>
              <Button
                onClick={() => setSummaryEditing(false)}
                type="button"
                variant="ghost"
              >
                {tt("cancel")}
              </Button>
            </form>
          ) : (
            <div className="flex items-start gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {ticket.summary}
              </h1>
              {editable.has("summary") && (
                <Button
                  aria-label={t("editSummary")}
                  onClick={() => setSummaryEditing(true)}
                  size="icon-xs"
                  variant="outline"
                >
                  <Pencil />
                </Button>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge>{ticket.status}</Badge>
            {ticket.issueType && <Badge>{ticket.issueType}</Badge>}
            {ticket.priority && <Badge>{ticket.priority}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() => void refresh()}
            variant="outline"
          >
            <RefreshCw className={busy ? "animate-spin" : undefined} />{" "}
            {t("refresh")}
          </Button>
          <Button onClick={() => setWorktreeOpen(true)} variant="outline">
            <GitBranch /> {tt("worktreeAction")}
          </Button>
          <Button asChild>
            <a href={ticket.jiraUrl} rel="noreferrer" target="_blank">
              {tt("openInJira")} <ExternalLink />
            </a>
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <JiraTicketActions onTicketChange={ticketChanged} ticket={ticket} />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex grid-cols-none flex-row items-center justify-between gap-3">
            <CardTitle>{t("details")}</CardTitle>
            {editFields.length > 0 && (
              <Button
                onClick={() => setDetailsOpen(true)}
                size="xs"
                variant="outline"
              >
                <Pencil /> {t("edit")}
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <TicketMetadata ticket={ticket} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tt("relatedIssues")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {relatedIssues.length > 0 ? (
              relatedIssues.map((link, index) => (
                <Link
                  className="block rounded border p-2 text-sm leading-tight hover:bg-muted"
                  href={`/jira/tickets/${encodeURIComponent(link.key)}`}
                  key={`${link.key}-${index}`}
                >
                  <span className="font-medium">{link.key}</span> ·{" "}
                  {link.summary}
                  <span className="block text-xs leading-tight text-muted-foreground">
                    {link.relationship}
                    {link.status ? ` · ${link.status}` : ""}
                  </span>
                </Link>
              ))
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent>
          {descriptionEditing ? (
            <div className="space-y-4">
              <div className="border-b pb-4">
                <CardTitle>{tt("descriptionTitle")}</CardTitle>
              </div>
              <JiraTextComposer
                allowEmpty={descriptionField?.required === false}
                busy={busy}
                initialFormat={
                  ticket.descriptionContent?.format === "JIRA_WIKI"
                    ? "JIRA_WIKI"
                    : "MARKDOWN"
                }
                initialValue={
                  ticket.descriptionContent?.format === "JIRA_WIKI"
                    ? ticket.descriptionContent.wikiMarkup
                    : (ticket.descriptionContent?.markdown ?? "")
                }
                onCancel={() => setDescriptionEditing(false)}
                onSubmit={saveDescription}
                submitLabel={t("saveDescription")}
              />
            </div>
          ) : (
            <JiraRichTextBlock
              content={ticket.descriptionContent}
              header={<CardTitle>{tt("descriptionTitle")}</CardTitle>}
              headerActions={
                <>
                  <JiraDescriptionHistory
                    history={ticketHistory}
                    ticket={ticket}
                  />
                  {editable.has("description") && (
                    <Button
                      onClick={() => setDescriptionEditing(true)}
                      size="xs"
                      variant="outline"
                    >
                      <Pencil /> {t("edit")}
                    </Button>
                  )}
                </>
              }
              headerClassName="border-b pb-4"
              sourceClassName="max-h-none overflow-visible break-words [overflow-wrap:anywhere]"
              value={ticket.description}
            />
          )}
        </CardContent>
      </Card>

      {(ticket.labels.length > 0 ||
        ticket.components.length > 0 ||
        ticket.fixVersions.length > 0 ||
        ticket.affectedVersions.length > 0 ||
        ticket.sprintNames.length > 0 ||
        ticket.attachments.length > 0) && (
        <div className="grid gap-5 lg:grid-cols-2">
          {(ticket.labels.length > 0 ||
            ticket.components.length > 0 ||
            ticket.fixVersions.length > 0 ||
            ticket.affectedVersions.length > 0 ||
            ticket.sprintNames.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle>{tt("classification")}</CardTitle>
              </CardHeader>
              <CardContent>
                <Classification ticket={ticket} />
              </CardContent>
            </Card>
          )}
          {ticket.attachments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{tt("attachments")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {ticket.attachments.map((attachment) => (
                  <a
                    className="block rounded border p-2 text-sm hover:bg-muted"
                    href={attachment.contentUrl ?? "#"}
                    key={attachment.id}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {attachment.filename}
                  </a>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <JiraTicketActivity
        history={ticketHistory}
        key={ticket.key}
        onTicketChange={ticketChanged}
        ticket={ticket}
        title={t("activity")}
      />

      <Card className="min-w-0 gap-0 overflow-hidden py-0">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              aria-controls="jira-all-fields"
              aria-expanded={fieldsOpen}
              className="-m-2 h-auto min-w-0 flex-1 justify-start p-2 text-left"
              onClick={() => setFieldsOpen((current) => !current)}
              type="button"
              variant="ghost"
            >
              <CardTitle>{t("allFields")}</CardTitle>
            </Button>
            <div className="ml-auto flex items-center justify-end gap-2">
              {fieldsOpen && (
                <Input
                  aria-label={t("searchFields")}
                  className="h-7 w-48 sm:w-64"
                  onChange={(event) => setFieldSearch(event.target.value)}
                  placeholder={t("searchFields")}
                  value={fieldSearch}
                />
              )}
              <Button
                aria-controls="jira-all-fields"
                aria-expanded={fieldsOpen}
                aria-label={
                  fieldsOpen ? t("collapseFields") : t("expandFields")
                }
                onClick={() => setFieldsOpen((current) => !current)}
                size="icon-sm"
                title={fieldsOpen ? t("collapseFields") : t("expandFields")}
                type="button"
                variant="ghost"
              >
                {fieldsOpen ? (
                  <ChevronDown className="size-5" />
                ) : (
                  <ChevronRight className="size-5" />
                )}
              </Button>
            </div>
          </div>
        </CardHeader>
        {fieldsOpen && (
          <Table className="table-fixed" id="jira-all-fields">
            <TableHeader>
              <TableRow>
                <TableHead className="w-40 whitespace-normal break-words sm:w-56">
                  {t("field")}
                </TableHead>
                <TableHead className="whitespace-normal break-words">
                  {t("value")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredFields.map((field) => (
                <TableRow key={field.id}>
                  <TableCell className="min-w-0 align-top whitespace-normal [overflow-wrap:anywhere]">
                    <p className="break-words font-medium">{field.name}</p>
                    <p className="break-words text-xs text-muted-foreground">
                      {field.id}
                      {field.custom ? ` · ${t("custom")}` : ""}
                    </p>
                  </TableCell>
                  <TableCell className="min-w-0 max-w-0 align-top whitespace-normal [overflow-wrap:anywhere]">
                    <JiraFieldValue field={field} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <EditDetailsDialog
        busy={busy}
        editFields={editFields}
        key={`${ticket.updatedAt}-${detailsOpen}`}
        onOpenChange={setDetailsOpen}
        onSave={async (input) => {
          await update(input);
          setDetailsOpen(false);
        }}
        open={detailsOpen}
        ticket={ticket}
      />
      <TicketWorktreeDialog
        issueKey={ticket.key}
        onOpenChange={setWorktreeOpen}
        open={worktreeOpen}
      />
    </section>
  );
}

function TicketMetadata({ ticket }: { ticket: JiraTicketDetail }) {
  const t = useTranslations("jiraTickets");
  const rows: Array<[string, ReactNode]> = [
    [
      t("assignee"),
      <JiraUser
        avatarUrl={ticket.assigneeAvatarUrl}
        key="assignee"
        name={ticket.assignee ?? t("unassigned")}
      />,
    ],
    [
      t("reporter"),
      ticket.reporter ? (
        <JiraUser
          avatarUrl={ticket.reporter.avatarUrl}
          key="reporter"
          name={ticket.reporter.displayName}
        />
      ) : (
        "—"
      ),
    ],
    [t("created"), <DateTime key="created" value={ticket.createdAt} />],
    [t("updated"), <DateTime key="updated" value={ticket.updatedAt} />],
    [t("due"), <DateTime key="due" value={ticket.dueAt} />],
    [t("resolved"), <DateTime key="resolved" value={ticket.resolvedAt} />],
  ];
  return (
    <dl className="space-y-3 text-sm">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Classification({ ticket }: { ticket: JiraTicketDetail }) {
  const t = useTranslations("jiraTickets");
  const rows: Array<[string, string[]]> = [
    [t("labels"), ticket.labels],
    [t("components"), ticket.components.map((item) => item.name)],
    [t("fixVersions"), ticket.fixVersions.map((item) => item.name)],
    [t("affectedVersions"), ticket.affectedVersions.map((item) => item.name)],
    [t("sprints"), ticket.sprintNames],
  ];
  return (
    <dl className="space-y-3 text-sm">
      {rows
        .filter(([, values]) => values.length > 0)
        .map(([label, values]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {values.map((value) => (
                <Badge key={value}>{value}</Badge>
              ))}
            </dd>
          </div>
        ))}
    </dl>
  );
}

function JiraFieldValue({ field }: { field: JiraTicketField }) {
  if (field.content)
    return (
      <div className="min-w-0 max-w-full overflow-hidden [overflow-wrap:anywhere] [&_a]:break-all [&_code]:break-all [&_pre]:max-w-full [&_pre]:break-all [&_pre]:whitespace-pre-wrap">
        <JiraRichTextBlock
          content={field.content}
          showFormatOverride={false}
          value={field.value}
        />
      </div>
    );
  if (field.value === null || field.value === undefined || field.value === "")
    return <span className="text-muted-foreground">—</span>;
  if (
    typeof field.value === "string" ||
    typeof field.value === "number" ||
    typeof field.value === "boolean"
  )
    return (
      <span className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
        {String(field.value)}
      </span>
    );
  return (
    <pre className="max-h-72 max-w-full overflow-y-auto break-all whitespace-pre-wrap text-xs">
      {JSON.stringify(field.value, null, 2)}
    </pre>
  );
}

type DetailDraft = {
  priorityId: string;
  labels: string;
  componentIds: string[];
  fixVersionIds: string[];
  affectedVersionIds: string[];
  dueDate: string;
};

function EditDetailsDialog({
  busy,
  editFields,
  onOpenChange,
  onSave,
  open,
  ticket,
}: {
  busy: boolean;
  editFields: JiraEditField[];
  onOpenChange: (open: boolean) => void;
  onSave: (input: Omit<UpdateJiraTicketInput, "issueKey">) => Promise<void>;
  open: boolean;
  ticket: JiraTicketDetail;
}) {
  const t = useTranslations("jiraTicketDetail");
  const tt = useTranslations("jiraTickets");
  const locale = useLocale();
  const initial = useMemo<DetailDraft>(
    () => ({
      priorityId:
        editFields
          .find((field) => field.id === "priority")
          ?.allowedValues.find((value) => value.name === ticket.priority)?.id ??
        "",
      labels: ticket.labels.join(", "),
      componentIds: ticket.components.flatMap((item) =>
        item.id ? [item.id] : [],
      ),
      fixVersionIds: ticket.fixVersions.flatMap((item) =>
        item.id ? [item.id] : [],
      ),
      affectedVersionIds: ticket.affectedVersions.flatMap((item) =>
        item.id ? [item.id] : [],
      ),
      dueDate: ticket.dueAt?.slice(0, 10) ?? "",
    }),
    [editFields, ticket],
  );
  const [draft, setDraft] = useState(initial);
  const [dueDateOpen, setDueDateOpen] = useState(false);
  const selectedDueDate = parseDateOnly(draft.dueDate);

  const byId = new Map(editFields.map((field) => [field.id, field]));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input: Omit<UpdateJiraTicketInput, "issueKey"> = {};
    if (byId.has("priority")) input.priorityId = draft.priorityId || null;
    if (byId.has("labels"))
      input.labels = draft.labels
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (byId.has("components")) input.componentIds = draft.componentIds;
    if (byId.has("fixVersions")) input.fixVersionIds = draft.fixVersionIds;
    if (byId.has("versions"))
      input.affectedVersionIds = draft.affectedVersionIds;
    if (byId.has("duedate")) input.dueDate = draft.dueDate || null;
    await onSave(input);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <form className="space-y-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t("editDetails")}</DialogTitle>
            <DialogDescription>{t("editDetailsDescription")}</DialogDescription>
          </DialogHeader>
          {byId.get("priority") && (
            <div>
              <Label className="mb-1.5 block" htmlFor="jira-priority">
                {tt("priority")}
              </Label>
              <Select
                onValueChange={(priorityId) =>
                  setDraft((current) => ({ ...current, priorityId }))
                }
                value={draft.priorityId}
              >
                <SelectTrigger id="jira-priority">
                  <SelectValue placeholder={t("none")} />
                </SelectTrigger>
                <SelectContent>
                  {byId.get("priority")!.allowedValues.map((value) => (
                    <SelectItem
                      key={value.id ?? value.name}
                      value={value.id ?? value.name}
                    >
                      {value.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {byId.has("labels") && (
            <div>
              <Label className="mb-1.5 block" htmlFor="jira-labels">
                {tt("labels")}
              </Label>
              <Input
                id="jira-labels"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    labels: event.target.value,
                  }))
                }
                placeholder={t("commaSeparated")}
                value={draft.labels}
              />
            </div>
          )}
          <EditableMultiField
            field={byId.get("components")}
            label={tt("components")}
            onChange={(componentIds) =>
              setDraft((current) => ({ ...current, componentIds }))
            }
            value={draft.componentIds}
          />
          <EditableMultiField
            field={byId.get("fixVersions")}
            label={tt("fixVersions")}
            onChange={(fixVersionIds) =>
              setDraft((current) => ({ ...current, fixVersionIds }))
            }
            value={draft.fixVersionIds}
          />
          <EditableMultiField
            field={byId.get("versions")}
            label={tt("affectedVersions")}
            onChange={(affectedVersionIds) =>
              setDraft((current) => ({ ...current, affectedVersionIds }))
            }
            value={draft.affectedVersionIds}
          />
          {byId.has("duedate") && (
            <div>
              <Label className="mb-1.5 block" htmlFor="jira-due-date">
                {tt("due")}
              </Label>
              <Popover onOpenChange={setDueDateOpen} open={dueDateOpen}>
                <PopoverTrigger asChild>
                  <Button
                    aria-label={t("pickDate")}
                    className="w-full justify-start font-normal"
                    disabled={busy}
                    id="jira-due-date"
                    type="button"
                    variant="outline"
                  >
                    <CalendarDays />
                    {selectedDueDate
                      ? formatDateValue(selectedDueDate, "short", {
                          locale,
                          showTime: false,
                        })
                      : t("pickDate")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto p-0">
                  <Calendar
                    autoFocus
                    captionLayout="dropdown"
                    endMonth={new Date(new Date().getFullYear() + 10, 11)}
                    mode="single"
                    onSelect={(nextDate) => {
                      if (!nextDate) return;
                      setDraft((current) => ({
                        ...current,
                        dueDate: toDateOnly(nextDate),
                      }));
                      setDueDateOpen(false);
                    }}
                    selected={selectedDueDate}
                    startMonth={new Date(new Date().getFullYear() - 10, 0)}
                  />
                  {selectedDueDate && (
                    <div className="border-t p-2">
                      <Button
                        className="w-full"
                        onClick={() => {
                          setDraft((current) => ({
                            ...current,
                            dueDate: "",
                          }));
                          setDueDateOpen(false);
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {t("clearDate")}
                      </Button>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          )}
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {tt("cancel")}
            </Button>
            <Button disabled={busy} type="submit">
              {busy ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditableMultiField({
  field,
  label,
  onChange,
  value,
}: {
  field?: JiraEditField;
  label: string;
  onChange: (value: string[]) => void;
  value: string[];
}) {
  if (!field) return null;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="grid max-h-40 gap-2 overflow-y-auto rounded border p-3 sm:grid-cols-2">
        {field.allowedValues.length === 0 ? (
          <p className="text-xs text-muted-foreground">—</p>
        ) : (
          field.allowedValues.map((option: JiraNamedValue) => {
            const id = option.id ?? option.name;
            return (
              <label className="flex items-center gap-2 text-sm" key={id}>
                <Checkbox
                  checked={value.includes(id)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked
                        ? [...value, id]
                        : value.filter((item) => item !== id),
                    )
                  }
                />
                {option.name}
              </label>
            );
          })
        )}
      </div>
    </fieldset>
  );
}
