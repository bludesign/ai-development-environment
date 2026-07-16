"use client";

import {
  AlertTriangle,
  Columns3,
  ExternalLink,
  FolderKanban,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Table2,
  Trash2,
  UserRound,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { AdfRenderer } from "@/components/jira/adf-renderer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  JiraAvailableProject,
  JiraProjectView,
  JiraSourceKind,
  JiraSourceView,
  JiraTicketBoard,
  JiraTicketDetail,
  JiraTicketSummary,
} from "@/services/jira/types";

const SOURCE_FIELDS = "id projectId name kind value boardId position";
const PROJECT_FIELDS = `id jiraId key name avatarUrl position sources { ${SOURCE_FIELDS} }`;
const SUMMARY_FIELDS =
  "id key summary statusId status statusCategory issueType priority assignee assigneeAvatarUrl projectKey updatedAt";
const CACHE_FIELDS = "source stale fetchedAt";
const BOARD_FIELDS = `source { ${SOURCE_FIELDS} } tickets { ${SUMMARY_FIELDS} } statusOrder cache { ${CACHE_FIELDS} } truncated warnings`;
const PERSON_FIELDS = "accountId displayName avatarUrl";
const LINK_FIELDS = "relationship key summary status";
const DETAIL_FIELDS = `${SUMMARY_FIELDS} jiraUrl description reporter { ${PERSON_FIELDS} } creator { ${PERSON_FIELDS} } labels components { id name } fixVersions { id name } affectedVersions { id name } sprintNames parent { ${LINK_FIELDS} } subtasks { ${LINK_FIELDS} } issueLinks { ${LINK_FIELDS} } attachments { id filename contentUrl mimeType size author { ${PERSON_FIELDS} } createdAt } comments { id author { ${PERSON_FIELDS} } body createdAt updatedAt } createdAt dueAt resolvedAt timeTracking cache { ${CACHE_FIELDS} } commentsCache { ${CACHE_FIELDS} }`;

function replaceParams(changes: Record<string, string | null>) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  window.history.pushState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}`,
  );
}

function displayDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

export function JiraTicketsPage() {
  const t = useTranslations("jiraTickets");
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<JiraProjectView[]>([]);
  const [board, setBoard] = useState<JiraTicketBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [boardLoading, setBoardLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [layout, setLayout] = useState<"table" | "board">("table");

  const requestedProjectId = searchParams.get("project");
  const requestedSourceId = searchParams.get("source");
  const issueKey = searchParams.get("issue");
  const selectedProject =
    projects.find((project) => project.id === requestedProjectId) ??
    projects[0] ??
    null;
  const selectedSource =
    selectedProject?.sources.find(
      (source) => source.id === requestedSourceId,
    ) ??
    selectedProject?.sources[0] ??
    null;

  const loadProjects = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        jiraProjects: JiraProjectView[];
      }>(`query JiraProjects { jiraProjects { ${PROJECT_FIELDS} } }`);
      setProjects(data.jiraProjects);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadProjects(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProject) return;
    const changes: Record<string, string | null> = {};
    if (requestedProjectId !== selectedProject.id)
      changes.project = selectedProject.id;
    if (selectedSource && requestedSourceId !== selectedSource.id)
      changes.source = selectedSource.id;
    if (Object.keys(changes).length > 0) replaceParams(changes);
  }, [requestedProjectId, requestedSourceId, selectedProject, selectedSource]);

  const loadBoard = useCallback(async (sourceId: string, force = false) => {
    setBoardLoading(true);
    try {
      const operation = force
        ? `mutation RefreshJiraSource($sourceId: ID!) { refreshJiraSource(sourceId: $sourceId) { ${BOARD_FIELDS} } }`
        : `query JiraTicketBoard($sourceId: ID!) { jiraTicketBoard(sourceId: $sourceId) { ${BOARD_FIELDS} } }`;
      const data = await controlPlaneRequest<Record<string, JiraTicketBoard>>(
        operation,
        { sourceId },
      );
      setBoard(force ? data.refreshJiraSource : data.jiraTicketBoard);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBoard(null);
    } finally {
      setBoardLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedSource) {
      const timeout = window.setTimeout(() => setBoard(null), 0);
      return () => window.clearTimeout(timeout);
    }
    const timeout = window.setTimeout(
      () => void loadBoard(selectedSource.id),
      0,
    );
    return () => window.clearTimeout(timeout);
  }, [loadBoard, selectedSource]);

  const groupedTickets = useMemo(() => {
    const groups = new Map<string, JiraTicketSummary[]>();
    for (const status of board?.statusOrder ?? []) groups.set(status, []);
    for (const ticket of board?.tickets ?? []) {
      const group = groups.get(ticket.status) ?? [];
      group.push(ticket);
      groups.set(ticket.status, group);
    }
    return [...groups.entries()];
  }, [board]);

  return (
    <section className="mx-auto flex w-full max-w-[1600px] flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() =>
              setLayout((current) => (current === "table" ? "board" : "table"))
            }
            variant="outline"
          >
            {layout === "table" ? <Columns3 /> : <Table2 />}
            {layout === "table" ? t("showBoardLayout") : t("showTableLayout")}
          </Button>
          <Button
            disabled={!selectedSource || boardLoading}
            onClick={() =>
              selectedSource && void loadBoard(selectedSource.id, true)
            }
            variant="outline"
          >
            <RefreshCw className={boardLoading ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
          <Button onClick={() => setManagerOpen(true)}>
            <Settings2 />
            {t("manage")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          {t("loading")}
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <FolderKanban className="mx-auto size-9 text-muted-foreground" />
          <h2 className="mt-3 font-medium">{t("emptyProjects")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("emptyProjectsDescription")}
          </p>
          <Button className="mt-4" onClick={() => setManagerOpen(true)}>
            <Plus />
            {t("addProject")}
          </Button>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto pb-1">
            <Tabs
              value={selectedProject?.id}
              onValueChange={(projectId) => {
                const project = projects.find((item) => item.id === projectId);
                replaceParams({
                  project: projectId,
                  source: project?.sources[0]?.id ?? null,
                  issue: null,
                });
              }}
            >
              <TabsList aria-label={t("projectTabs")}>
                {projects.map((project) => (
                  <TabsTrigger key={project.id} value={project.id}>
                    {project.key} · {project.name}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {selectedProject && selectedProject.sources.length > 0 ? (
            <div className="overflow-x-auto border-b pb-3">
              <Tabs
                value={selectedSource?.id}
                onValueChange={(sourceId) =>
                  replaceParams({ source: sourceId, issue: null })
                }
              >
                <TabsList
                  aria-label={t("sourceTabs")}
                  className="bg-transparent p-0"
                >
                  {selectedProject.sources.map((source) => (
                    <TabsTrigger key={source.id} value={source.id}>
                      {source.name}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <h2 className="font-medium">{t("emptySources")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("emptySourcesDescription")}
              </p>
              <Button className="mt-4" onClick={() => setManagerOpen(true)}>
                <Plus />
                {t("addSource")}
              </Button>
            </div>
          )}

          {board?.cache.stale && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {t("staleWarning")}
            </div>
          )}
          {board?.truncated && (
            <div className="rounded-lg border bg-muted p-3 text-sm">
              {t("truncatedWarning")}
            </div>
          )}
          {board?.warnings.map((warning) => (
            <div
              key={warning}
              className="rounded-lg border bg-muted p-3 text-sm"
            >
              {warning}
            </div>
          ))}

          {selectedSource && boardLoading && !board ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t("loadingTickets")}
            </div>
          ) : board && board.tickets.length === 0 ? (
            <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
              {t("emptyTickets")}
            </div>
          ) : board ? (
            layout === "table" ? (
              <div className="space-y-5 pb-4">
                {groupedTickets.map(([status, tickets]) => (
                  <section
                    key={status}
                    className="overflow-hidden rounded-xl border bg-card"
                  >
                    <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-3">
                      <h2 className="font-medium">{status}</h2>
                      <Badge>{tickets.length}</Badge>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>{t("ticket")}</TableHead>
                          <TableHead>{t("issueType")}</TableHead>
                          <TableHead>{t("priority")}</TableHead>
                          <TableHead>{t("assignee")}</TableHead>
                          <TableHead>{t("updated")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {tickets.map((ticket) => (
                          <TableRow key={ticket.key}>
                            <TableCell className="min-w-80 whitespace-normal">
                              <button
                                className="group block text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() =>
                                  replaceParams({ issue: ticket.key })
                                }
                                type="button"
                              >
                                <span className="block text-xs font-semibold text-primary group-hover:underline">
                                  {ticket.key}
                                </span>
                                <span className="mt-1 block font-medium">
                                  {ticket.summary}
                                </span>
                              </button>
                            </TableCell>
                            <TableCell>
                              {ticket.issueType ?? t("issue")}
                            </TableCell>
                            <TableCell>
                              {ticket.priority ? (
                                <Badge>{ticket.priority}</Badge>
                              ) : (
                                "—"
                              )}
                            </TableCell>
                            <TableCell>
                              <span className="flex items-center gap-1.5">
                                <UserRound className="size-3.5 text-muted-foreground" />
                                {ticket.assignee ?? t("unassigned")}
                              </span>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {displayDate(ticket.updatedAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </section>
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto pb-4">
                <div className="flex min-w-max items-start gap-4">
                  {groupedTickets.map(([status, tickets]) => (
                    <section
                      key={status}
                      className="w-[19rem] rounded-xl bg-muted/50 p-3"
                    >
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <h2 className="font-medium">{status}</h2>
                        <Badge>{tickets.length}</Badge>
                      </div>
                      <div className="space-y-2">
                        {tickets.map((ticket) => (
                          <button
                            key={ticket.key}
                            className="w-full rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => replaceParams({ issue: ticket.key })}
                            type="button"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-xs font-semibold text-primary">
                                {ticket.key}
                              </span>
                              {ticket.priority && (
                                <Badge>{ticket.priority}</Badge>
                              )}
                            </div>
                            <p className="mt-2 line-clamp-3 text-sm font-medium">
                              {ticket.summary}
                            </p>
                            <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span>{ticket.issueType ?? t("issue")}</span>
                              <span className="flex min-w-0 items-center gap-1">
                                <UserRound className="size-3" />
                                <span className="truncate">
                                  {ticket.assignee ?? t("unassigned")}
                                </span>
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            )
          ) : null}
        </>
      )}

      <JiraManagerDialog
        onProjectsChanged={setProjects}
        open={managerOpen}
        projects={projects}
        selectedProjectId={selectedProject?.id ?? null}
        setOpen={setManagerOpen}
      />
      <TicketDrawer
        issueKey={issueKey}
        onClose={() => replaceParams({ issue: null })}
      />
    </section>
  );
}

function JiraManagerDialog({
  open,
  setOpen,
  projects,
  selectedProjectId,
  onProjectsChanged,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  projects: JiraProjectView[];
  selectedProjectId: string | null;
  onProjectsChanged: (projects: JiraProjectView[]) => void;
}) {
  const t = useTranslations("jiraTickets");
  const [available, setAvailable] = useState<JiraAvailableProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [sourceKind, setSourceKind] = useState<JiraSourceKind>("JQL");
  const [sourceValue, setSourceValue] = useState("");
  const [editing, setEditing] = useState<JiraSourceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(async () => {
      try {
        const data = await controlPlaneRequest<{
          jiraAvailableProjects: JiraAvailableProject[];
        }>("query { jiraAvailableProjects { jiraId key name avatarUrl } }");
        setAvailable(data.jiraAvailableProjects);
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [open]);

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ??
    projects[0] ??
    null;
  const unusedProjects = available.filter(
    (candidate) =>
      !projects.some((project) => project.jiraId === candidate.jiraId),
  );

  const addProject = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        addJiraProject: JiraProjectView[];
      }>(
        `mutation AddJiraProject($jiraId: ID!) { addJiraProject(jiraId: $jiraId) { ${PROJECT_FIELDS} } }`,
        { jiraId: projectId },
      );
      onProjectsChanged(data.addJiraProject);
      setProjectId("");
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (id: string) => {
    if (!window.confirm(t("confirmRemoveProject"))) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        removeJiraProject: JiraProjectView[];
      }>(
        `mutation RemoveJiraProject($projectId: ID!) { removeJiraProject(projectId: $projectId) { ${PROJECT_FIELDS} } }`,
        { projectId: id },
      );
      onProjectsChanged(data.removeJiraProject);
      replaceParams({
        project: data.removeJiraProject[0]?.id ?? null,
        source: data.removeJiraProject[0]?.sources[0]?.id ?? null,
        issue: null,
      });
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const saveSource = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProject) return;
    setBusy(true);
    try {
      const operation = editing
        ? `mutation UpdateJiraSource($input: UpdateJiraSourceInput!) { updateJiraSource(input: $input) { ${PROJECT_FIELDS} } }`
        : `mutation CreateJiraSource($input: CreateJiraSourceInput!) { createJiraSource(input: $input) { ${PROJECT_FIELDS} } }`;
      const input = editing
        ? {
            id: editing.id,
            name: sourceName,
            kind: sourceKind,
            value: sourceValue,
          }
        : {
            projectId: selectedProject.id,
            name: sourceName,
            kind: sourceKind,
            value: sourceValue,
          };
      const data = await controlPlaneRequest<Record<string, JiraProjectView[]>>(
        operation,
        { input },
      );
      onProjectsChanged(
        editing ? data.updateJiraSource : data.createJiraSource,
      );
      setSourceName("");
      setSourceValue("");
      setSourceKind("JQL");
      setEditing(null);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const deleteSource = async (id: string) => {
    if (!window.confirm(t("confirmDeleteSource"))) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        deleteJiraSource: JiraProjectView[];
      }>(
        `mutation DeleteJiraSource($id: ID!) { deleteJiraSource(id: $id) { ${PROJECT_FIELDS} } }`,
        { id },
      );
      onProjectsChanged(data.deleteJiraSource);
      const project = data.deleteJiraSource.find(
        (item) => item.id === selectedProject?.id,
      );
      replaceParams({ source: project?.sources[0]?.id ?? null, issue: null });
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("manageTitle")}</DialogTitle>
          <DialogDescription>{t("manageDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="grid gap-6 md:grid-cols-2">
          <section className="space-y-3">
            <h3 className="font-medium">{t("projects")}</h3>
            <div className="flex gap-2">
              <Select
                aria-label={t("availableProjects")}
                onChange={(event) => setProjectId(event.target.value)}
                value={projectId}
              >
                <option value="">{t("selectProject")}</option>
                {unusedProjects.map((project) => (
                  <option key={project.jiraId} value={project.jiraId}>
                    {project.key} · {project.name}
                  </option>
                ))}
              </Select>
              <Button
                disabled={!projectId || busy}
                onClick={() => void addProject()}
                size="icon"
              >
                <Plus />
                <span className="sr-only">{t("addProject")}</span>
              </Button>
            </div>
            <div className="space-y-2">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="flex items-center justify-between gap-2 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {project.key} · {project.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("sourceCount", { count: project.sources.length })}
                    </p>
                  </div>
                  <Button
                    disabled={busy}
                    onClick={() => void removeProject(project.id)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2 />
                    <span className="sr-only">{t("removeProject")}</span>
                  </Button>
                </div>
              ))}
            </div>
          </section>
          <section className="space-y-3">
            <h3 className="font-medium">
              {t("sourcesFor", { project: selectedProject?.key ?? "—" })}
            </h3>
            {selectedProject?.sources.map((source) => (
              <div
                key={source.id}
                className="flex items-start justify-between gap-2 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{source.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {source.kind} · {source.value}
                  </p>
                </div>
                <div className="flex">
                  <Button
                    onClick={() => {
                      setEditing(source);
                      setSourceName(source.name);
                      setSourceKind(source.kind);
                      setSourceValue(source.value);
                    }}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Pencil />
                    <span className="sr-only">{t("editSource")}</span>
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void deleteSource(source.id)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2 />
                    <span className="sr-only">{t("deleteSource")}</span>
                  </Button>
                </div>
              </div>
            ))}
            {selectedProject && (
              <form
                className="space-y-3 rounded-lg border p-3"
                onSubmit={(event) => void saveSource(event)}
              >
                <div>
                  <label
                    className="mb-1 block text-xs font-medium"
                    htmlFor="source-name"
                  >
                    {t("sourceName")}
                  </label>
                  <Input
                    id="source-name"
                    maxLength={100}
                    onChange={(event) => setSourceName(event.target.value)}
                    required
                    value={sourceName}
                  />
                </div>
                <div>
                  <label
                    className="mb-1 block text-xs font-medium"
                    htmlFor="source-kind"
                  >
                    {t("sourceType")}
                  </label>
                  <Select
                    id="source-kind"
                    onChange={(event) =>
                      setSourceKind(event.target.value as JiraSourceKind)
                    }
                    value={sourceKind}
                  >
                    <option value="JQL">JQL</option>
                    <option value="BOARD">{t("boardUrl")}</option>
                  </Select>
                </div>
                <div>
                  <label
                    className="mb-1 block text-xs font-medium"
                    htmlFor="source-value"
                  >
                    {sourceKind === "JQL" ? "JQL" : t("boardUrl")}
                  </label>
                  <Textarea
                    id="source-value"
                    onChange={(event) => setSourceValue(event.target.value)}
                    required
                    value={sourceValue}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  {editing && (
                    <Button
                      onClick={() => {
                        setEditing(null);
                        setSourceName("");
                        setSourceValue("");
                      }}
                      type="button"
                      variant="ghost"
                    >
                      {t("cancel")}
                    </Button>
                  )}
                  <Button disabled={busy} type="submit">
                    {editing ? t("saveSource") : t("addSource")}
                  </Button>
                </div>
              </form>
            )}
          </section>
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TicketDrawer({
  issueKey,
  onClose,
}: {
  issueKey: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("jiraTickets");
  const [ticket, setTicket] = useState<JiraTicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
          `query JiraTicket($issueKey: ID!) { jiraTicket(issueKey: $issueKey) { ${DETAIL_FIELDS} } }`,
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

  return (
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
              <LoaderCircle className="size-4 animate-spin" />
              {t("loadingTicket")}
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          {ticket && (
            <>
              {(ticket.cache.stale || ticket.commentsCache.stale) && (
                <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                  <AlertTriangle className="size-4 shrink-0" />
                  {t("staleTicket")}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Badge>{ticket.status}</Badge>
                {ticket.issueType && <Badge>{ticket.issueType}</Badge>}
                {ticket.priority && <Badge>{ticket.priority}</Badge>}
                <a
                  className="ml-auto inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  href={ticket.jiraUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {t("openInJira")}
                  <ExternalLink className="size-3" />
                </a>
              </div>
              <DetailGrid ticket={ticket} />
              <section>
                <h3 className="mb-2 font-semibold">{t("descriptionTitle")}</h3>
                <div className="rounded-lg border p-4">
                  <AdfRenderer value={ticket.description} />
                </div>
              </section>
              {(ticket.labels.length > 0 ||
                ticket.components.length > 0 ||
                ticket.fixVersions.length > 0 ||
                ticket.sprintNames.length > 0) && (
                <section>
                  <h3 className="mb-2 font-semibold">{t("classification")}</h3>
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    {ticket.labels.length > 0 && (
                      <div>
                        <dt className="text-muted-foreground">{t("labels")}</dt>
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
                  <div className="space-y-2">
                    {[
                      ...(ticket.parent ? [ticket.parent] : []),
                      ...ticket.subtasks,
                      ...ticket.issueLinks,
                    ].map((link, index) => (
                      <div
                        key={`${link.key}-${index}`}
                        className="rounded-lg border p-3 text-sm"
                      >
                        <div className="flex justify-between gap-2">
                          <span className="font-medium">
                            {link.key} · {link.summary}
                          </span>
                          {link.status && <Badge>{link.status}</Badge>}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {link.relationship}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {ticket.attachments.length > 0 && (
                <section>
                  <h3 className="mb-2 font-semibold">{t("attachments")}</h3>
                  <div className="space-y-2">
                    {ticket.attachments.map((attachment) => (
                      <a
                        key={attachment.id}
                        className="flex items-center justify-between rounded-lg border p-3 text-sm hover:bg-muted"
                        href={attachment.contentUrl ?? "#"}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <span>{attachment.filename}</span>
                        <span className="text-xs text-muted-foreground">
                          {attachment.size
                            ? `${Math.round(attachment.size / 1024)} KB`
                            : ""}
                        </span>
                      </a>
                    ))}
                  </div>
                </section>
              )}
              <section>
                <h3 className="mb-2 font-semibold">
                  {t("comments", { count: ticket.comments.length })}
                </h3>
                {ticket.comments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("noComments")}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {ticket.comments.map((comment) => (
                      <article
                        key={comment.id}
                        className="rounded-lg border p-4"
                      >
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">
                            {comment.author?.displayName ?? t("unknownUser")}
                          </span>
                          <time className="text-xs text-muted-foreground">
                            {displayDate(comment.createdAt)}
                          </time>
                        </div>
                        <AdfRenderer value={comment.body} />
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
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
