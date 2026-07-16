"use client";

import {
  AlertTriangle,
  ChevronDown,
  Columns3,
  FolderKanban,
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
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Item } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  JiraAvailableProject,
  JiraProjectStatus,
  JiraProjectView,
  JiraSourceKind,
  JiraSourceView,
  JiraTicketBoard,
  JiraTicketAssignmentFilter,
  JiraTicketSummary,
} from "@/services/jira/types";

const SOURCE_FIELDS = "id projectId name kind value boardId position";
const PROJECT_FIELDS = `id jiraId key name avatarUrl position ticketAssignmentFilter hideCompletedTickets completedStatusIds sources { ${SOURCE_FIELDS} }`;
const SUMMARY_FIELDS =
  "id key summary statusId status statusCategory issueType priority assignee assigneeAccountId assigneeAvatarUrl projectKey updatedAt";
const CACHE_FIELDS = "source stale fetchedAt";
const BOARD_FIELDS = `source { ${SOURCE_FIELDS} } tickets { ${SUMMARY_FIELDS} } statusOrder cache { ${CACHE_FIELDS} } truncated warnings`;

const PRIORITY_CLASSES: Record<string, string> = {
  highest: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  high: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  medium:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  lowest:
    "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
};

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

function priorityClass(priority: string) {
  return PRIORITY_CLASSES[priority.trim().toLowerCase()];
}

function AssigneeAvatar({
  avatarUrl,
  compact = false,
}: {
  avatarUrl: string | null;
  compact?: boolean;
}) {
  return (
    <Avatar aria-hidden="true" className={compact ? "size-4" : "size-5"}>
      <AvatarImage alt="" src={avatarUrl ?? undefined} />
      <AvatarFallback>
        <UserRound className={compact ? "size-3" : "size-3.5"} />
      </AvatarFallback>
    </Avatar>
  );
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
  const boardRequestIdRef = useRef(0);
  const displayedBoard = board?.source.id === selectedSource?.id ? board : null;

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
    const requestId = ++boardRequestIdRef.current;
    setBoardLoading(true);
    setBoard((current) => (current?.source.id === sourceId ? current : null));
    try {
      const operation = force
        ? `mutation RefreshJiraSource($sourceId: ID!) { refreshJiraSource(sourceId: $sourceId) { ${BOARD_FIELDS} } }`
        : `query JiraTicketBoard($sourceId: ID!) { jiraTicketBoard(sourceId: $sourceId) { ${BOARD_FIELDS} } }`;
      const data = await controlPlaneRequest<Record<string, JiraTicketBoard>>(
        operation,
        { sourceId },
      );
      if (requestId !== boardRequestIdRef.current) return;
      setBoard(force ? data.refreshJiraSource : data.jiraTicketBoard);
      setError(null);
    } catch (value) {
      if (requestId !== boardRequestIdRef.current) return;
      setError(value instanceof Error ? value.message : String(value));
      setBoard(null);
    } finally {
      if (requestId === boardRequestIdRef.current) setBoardLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedSource) {
      boardRequestIdRef.current += 1;
      const timeout = window.setTimeout(() => {
        setBoard(null);
        setBoardLoading(false);
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    const timeout = window.setTimeout(
      () => void loadBoard(selectedSource.id),
      0,
    );
    return () => {
      window.clearTimeout(timeout);
      boardRequestIdRef.current += 1;
    };
  }, [loadBoard, selectedSource]);

  const groupedTickets = useMemo(() => {
    const groups = new Map<string, JiraTicketSummary[]>();
    for (const status of displayedBoard?.statusOrder ?? [])
      groups.set(status, []);
    for (const ticket of displayedBoard?.tickets ?? []) {
      const group = groups.get(ticket.status) ?? [];
      group.push(ticket);
      groups.set(ticket.status, group);
    }
    return [...groups.entries()];
  }, [displayedBoard]);

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
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loading")}
        </div>
      ) : projects.length === 0 ? (
        <Empty className="border py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderKanban />
            </EmptyMedia>
            <EmptyTitle>{t("emptyProjects")}</EmptyTitle>
            <EmptyDescription>{t("emptyProjectsDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button className="mt-4" onClick={() => setManagerOpen(true)}>
            <Plus />
            {t("addProject")}
          </Button>
        </Empty>
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
                    {project.key}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {selectedProject && selectedProject.sources.length > 1 ? (
            <div className="overflow-x-auto border-b pb-3">
              <Tabs
                value={selectedSource?.id}
                onValueChange={(sourceId) =>
                  replaceParams({ source: sourceId, issue: null })
                }
              >
                <TabsList aria-label={t("sourceTabs")} variant="line">
                  {selectedProject.sources.map((source) => (
                    <TabsTrigger key={source.id} value={source.id}>
                      {source.name}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          ) : selectedProject?.sources.length === 0 ? (
            <Empty className="border py-8">
              <EmptyHeader>
                <EmptyTitle>{t("emptySources")}</EmptyTitle>
                <EmptyDescription>
                  {t("emptySourcesDescription")}
                </EmptyDescription>
              </EmptyHeader>
              <Button className="mt-4" onClick={() => setManagerOpen(true)}>
                <Plus />
                {t("addSource")}
              </Button>
            </Empty>
          ) : null}

          {displayedBoard?.cache.stale && (
            <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300">
              <AlertTriangle />
              <AlertDescription className="text-current">
                {t("staleWarning")}
              </AlertDescription>
            </Alert>
          )}
          {displayedBoard?.truncated && (
            <Alert className="bg-muted">
              <AlertDescription>{t("truncatedWarning")}</AlertDescription>
            </Alert>
          )}
          {displayedBoard?.warnings.map((warning) => (
            <Alert className="bg-muted" key={warning}>
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}

          {selectedSource && boardLoading && !displayedBoard ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner />
              {t("loadingTickets")}
            </div>
          ) : displayedBoard && displayedBoard.tickets.length === 0 ? (
            <Empty className="border py-10">
              <EmptyHeader>
                <EmptyDescription>{t("emptyTickets")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : displayedBoard ? (
            layout === "table" ? (
              <div className="space-y-5 pb-4">
                {groupedTickets.map(([status, tickets]) => (
                  <Card key={status} className="gap-0 py-0">
                    <CardHeader className="flex grid-cols-none flex-row items-center justify-between gap-2 border-b bg-muted/40 py-3">
                      <h2 className="font-medium">{status}</h2>
                      <Badge>{tickets.length}</Badge>
                    </CardHeader>
                    <CardContent className="px-0">
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
                                <Button
                                  className="group h-auto w-full flex-col items-start justify-start gap-0 px-1 py-0.5 text-left whitespace-normal"
                                  onClick={() =>
                                    replaceParams({ issue: ticket.key })
                                  }
                                  type="button"
                                  variant="ghost"
                                >
                                  <span className="block text-xs font-semibold text-primary group-hover:underline">
                                    {ticket.key}
                                  </span>
                                  <span className="mt-1 block font-medium">
                                    {ticket.summary}
                                  </span>
                                </Button>
                              </TableCell>
                              <TableCell>
                                {ticket.issueType ?? t("issue")}
                              </TableCell>
                              <TableCell>
                                {ticket.priority ? (
                                  <Badge
                                    className={priorityClass(ticket.priority)}
                                  >
                                    {ticket.priority}
                                  </Badge>
                                ) : (
                                  "—"
                                )}
                              </TableCell>
                              <TableCell>
                                <span className="flex items-center gap-1.5">
                                  <AssigneeAvatar
                                    avatarUrl={ticket.assigneeAvatarUrl}
                                  />
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
                    </CardContent>
                  </Card>
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
                          <Button
                            key={ticket.key}
                            className="h-auto w-full flex-col items-stretch rounded-lg p-3 text-left whitespace-normal shadow-sm"
                            onClick={() => replaceParams({ issue: ticket.key })}
                            type="button"
                            variant="outline"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-xs font-semibold text-primary">
                                {ticket.key}
                              </span>
                              {ticket.priority && (
                                <Badge
                                  className={priorityClass(ticket.priority)}
                                >
                                  {ticket.priority}
                                </Badge>
                              )}
                            </div>
                            <p className="mt-2 line-clamp-3 text-sm font-medium">
                              {ticket.summary}
                            </p>
                            <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span>{ticket.issueType ?? t("issue")}</span>
                              <span className="flex min-w-0 items-center gap-1">
                                <AssigneeAvatar
                                  avatarUrl={ticket.assigneeAvatarUrl}
                                  compact
                                />
                                <span className="truncate">
                                  {ticket.assignee ?? t("unassigned")}
                                </span>
                              </span>
                            </div>
                          </Button>
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
      <JiraTicketDrawer
        issueKey={issueKey}
        onClose={() => replaceParams({ issue: null })}
      />
    </section>
  );
}

function StatusMultiSelect({
  statuses,
  value,
  onChange,
  label,
  placeholder,
  disabled,
}: {
  statuses: JiraProjectStatus[];
  value: string[];
  onChange: (value: string[]) => void;
  label: string;
  placeholder: string;
  disabled?: boolean;
}) {
  const selected = new Set(value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={label}
          className="w-full justify-between font-normal"
          disabled={disabled}
          type="button"
          variant="outline"
        >
          <span className="truncate">
            {value.length > 0 ? `${value.length} ${label}` : placeholder}
          </span>
          <ChevronDown className="shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="z-60 max-h-64">
        {statuses.map((status) => (
          <DropdownMenuCheckboxItem
            checked={selected.has(status.id)}
            key={status.id}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...selected, status.id]
                  : value.filter((statusId) => statusId !== status.id),
              )
            }
            onSelect={(event) => event.preventDefault()}
          >
            <span className="truncate">{status.name}</span>
            <span className="ml-auto mr-5 pl-2 text-xs text-muted-foreground">
              {status.category}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const tc = useTranslations("common");
  const [available, setAvailable] = useState<JiraAvailableProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [managedProjectId, setManagedProjectId] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceKind, setSourceKind] = useState<JiraSourceKind>("JQL");
  const [sourceValue, setSourceValue] = useState("");
  const [editing, setEditing] = useState<JiraSourceView | null>(null);
  const [statuses, setStatuses] = useState<JiraProjectStatus[]>([]);
  const [statusesLoading, setStatusesLoading] = useState(false);
  const [assignmentFilter, setAssignmentFilter] =
    useState<JiraTicketAssignmentFilter>("ALL");
  const [hideCompletedTickets, setHideCompletedTickets] = useState(false);
  const [completedStatusIds, setCompletedStatusIds] = useState<string[]>([]);
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
    projects.find((project) => project.id === managedProjectId) ??
    projects.find((project) => project.id === selectedProjectId) ??
    projects[0] ??
    null;
  const unusedProjects = available.filter(
    (candidate) =>
      !projects.some((project) => project.jiraId === candidate.jiraId),
  );

  useEffect(() => {
    if (!open || !selectedProject) return;
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      setAssignmentFilter(selectedProject.ticketAssignmentFilter);
      setHideCompletedTickets(selectedProject.hideCompletedTickets);
      setCompletedStatusIds(selectedProject.completedStatusIds);
      setStatusesLoading(true);
      try {
        const data = await controlPlaneRequest<{
          jiraProjectStatuses: JiraProjectStatus[];
        }>(
          "query JiraProjectStatuses($projectId: ID!) { jiraProjectStatuses(projectId: $projectId) { id name category } }",
          { projectId: selectedProject.id },
        );
        if (cancelled) return;
        setStatuses(data.jiraProjectStatuses);
        setError(null);
      } catch (value) {
        if (cancelled) return;
        setError(value instanceof Error ? value.message : String(value));
        setStatuses([]);
      } finally {
        if (!cancelled) setStatusesLoading(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [open, selectedProject]);

  const chooseProject = (id: string) => {
    setManagedProjectId(id);
    setEditing(null);
    setSourceName("");
    setSourceValue("");
    setSourceKind("JQL");
  };

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
      const addedProject = data.addJiraProject.find(
        (project) => project.jiraId === projectId,
      );
      if (addedProject) setManagedProjectId(addedProject.id);
      setProjectId("");
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (id: string) => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        removeJiraProject: JiraProjectView[];
      }>(
        `mutation RemoveJiraProject($projectId: ID!) { removeJiraProject(projectId: $projectId) { ${PROJECT_FIELDS} } }`,
        { projectId: id },
      );
      onProjectsChanged(data.removeJiraProject);
      if (id === selectedProject?.id) {
        setManagedProjectId(data.removeJiraProject[0]?.id ?? null);
      }
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

  const saveDisplaySettings = async () => {
    if (!selectedProject) return;
    setBusy(true);
    try {
      const input = {
        projectId: selectedProject.id,
        ticketAssignmentFilter: assignmentFilter,
        hideCompletedTickets,
        completedStatusIds,
      };
      const data = await controlPlaneRequest<{
        updateJiraProjectDisplaySettings: JiraProjectView[];
      }>(
        `mutation UpdateJiraProjectDisplaySettings($input: UpdateJiraProjectDisplaySettingsInput!) { updateJiraProjectDisplaySettings(input: $input) { ${PROJECT_FIELDS} } }`,
        { input },
      );
      onProjectsChanged(data.updateJiraProjectDisplaySettings);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setManagedProjectId(null);
        setOpen(nextOpen);
      }}
      open={open}
    >
      <DialogContent className="overflow-x-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("manageTitle")}</DialogTitle>
          <DialogDescription>{t("manageDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid min-w-0 gap-6 md:grid-cols-2">
          <section className="min-w-0 space-y-3">
            <h3 className="font-medium">{t("projects")}</h3>
            <div className="flex gap-2">
              <Select onValueChange={setProjectId} value={projectId}>
                <SelectTrigger
                  aria-label={t("availableProjects")}
                  className="w-full"
                >
                  <SelectValue placeholder={t("selectProject")} />
                </SelectTrigger>
                <SelectContent className="z-60">
                  {unusedProjects.map((project) => (
                    <SelectItem key={project.jiraId} value={project.jiraId}>
                      {project.key} · {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
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
                <Item
                  key={project.id}
                  className={`min-w-0 gap-2 p-1 ${
                    project.id === selectedProject?.id
                      ? "border-primary bg-primary/5"
                      : ""
                  }`}
                  variant="outline"
                >
                  <Button
                    aria-pressed={project.id === selectedProject?.id}
                    className="h-auto min-w-0 flex-1 flex-col items-start p-2 text-left whitespace-normal"
                    onClick={() => chooseProject(project.id)}
                    type="button"
                    variant="ghost"
                  >
                    <p className="truncate text-sm font-medium">
                      {project.key} · {project.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("sourceCount", { count: project.sources.length })}
                    </p>
                  </Button>
                  <ConfirmationDialog
                    actionLabel={t("removeProject")}
                    cancelLabel={tc("cancel")}
                    description={tc("cannotBeUndone")}
                    onConfirm={() => removeProject(project.id)}
                    title={t("confirmRemoveProject")}
                    trigger={
                      <Button disabled={busy} size="icon-sm" variant="ghost">
                        <Trash2 />
                        <span className="sr-only">{t("removeProject")}</span>
                      </Button>
                    }
                  />
                </Item>
              ))}
            </div>
          </section>
          <section className="min-w-0 space-y-3">
            <h3 className="font-medium">
              {t("sourcesFor", { project: selectedProject?.key ?? "—" })}
            </h3>
            {selectedProject?.sources.map((source) => (
              <Item
                key={source.id}
                className="min-w-0 items-start gap-2 overflow-hidden"
                variant="outline"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{source.name}</p>
                  <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <span className="shrink-0">{source.kind} ·</span>
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl] md:[direction:ltr]">
                      <bdi>{source.value}</bdi>
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0">
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
                  <ConfirmationDialog
                    actionLabel={t("deleteSource")}
                    cancelLabel={tc("cancel")}
                    description={tc("cannotBeUndone")}
                    onConfirm={() => deleteSource(source.id)}
                    title={t("confirmDeleteSource")}
                    trigger={
                      <Button disabled={busy} size="icon-sm" variant="ghost">
                        <Trash2 />
                        <span className="sr-only">{t("deleteSource")}</span>
                      </Button>
                    }
                  />
                </div>
              </Item>
            ))}
            {selectedProject && (
              <form
                className="min-w-0 space-y-3 rounded-lg border p-3"
                onSubmit={(event) => void saveSource(event)}
              >
                <div>
                  <Label
                    className="mb-1 block text-xs font-medium"
                    htmlFor="source-name"
                  >
                    {t("sourceName")}
                  </Label>
                  <Input
                    id="source-name"
                    maxLength={100}
                    onChange={(event) => setSourceName(event.target.value)}
                    required
                    value={sourceName}
                  />
                </div>
                <div>
                  <Label
                    className="mb-1 block text-xs font-medium"
                    htmlFor="source-kind"
                  >
                    {t("sourceType")}
                  </Label>
                  <Select
                    onValueChange={(value) =>
                      setSourceKind(value as JiraSourceKind)
                    }
                    value={sourceKind}
                  >
                    <SelectTrigger className="w-full" id="source-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-60">
                      <SelectItem value="JQL">JQL</SelectItem>
                      <SelectItem value="BOARD">{t("boardUrl")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label
                    className="mb-1 block text-xs font-medium"
                    htmlFor="source-value"
                  >
                    {sourceKind === "JQL" ? "JQL" : t("boardUrl")}
                  </Label>
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
            {selectedProject && (
              <section className="min-w-0 space-y-3 rounded-lg border p-3">
                <div>
                  <h4 className="text-sm font-medium">
                    {t("displaySettings")}
                  </h4>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("displaySettingsDescription")}
                  </p>
                </div>
                <div>
                  <Label
                    className="mb-1 block text-xs font-medium"
                    htmlFor="ticket-assignment-filter"
                  >
                    {t("ticketsToShow")}
                  </Label>
                  <Select
                    onValueChange={(value) =>
                      setAssignmentFilter(value as JiraTicketAssignmentFilter)
                    }
                    value={assignmentFilter}
                  >
                    <SelectTrigger
                      className="w-full"
                      id="ticket-assignment-filter"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-60">
                      <SelectItem value="ALL">{t("allTickets")}</SelectItem>
                      <SelectItem value="UNASSIGNED_OR_SELF">
                        {t("unassignedOrSelfAssigned")}
                      </SelectItem>
                      <SelectItem value="SELF_IN_PROGRESS">
                        {t("selfAssignedInProgress")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={hideCompletedTickets}
                    className="mt-0.5"
                    id="hide-completed-tickets"
                    onCheckedChange={(checked) =>
                      setHideCompletedTickets(checked === true)
                    }
                  />
                  <Label
                    className="block leading-normal"
                    htmlFor="hide-completed-tickets"
                  >
                    <span>
                      <span className="block font-medium">
                        {t("hideCompletedTickets")}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t("hideCompletedTicketsDescription")}
                      </span>
                    </span>
                  </Label>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium">
                    {t("completedStatuses")}
                  </p>
                  <StatusMultiSelect
                    disabled={!hideCompletedTickets || statusesLoading}
                    label={t("completedStatuses")}
                    onChange={setCompletedStatusIds}
                    placeholder={
                      statusesLoading
                        ? t("loadingStatuses")
                        : t("selectCompletedStatuses")
                    }
                    statuses={statuses}
                    value={completedStatusIds}
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    disabled={busy}
                    onClick={() => void saveDisplaySettings()}
                    type="button"
                  >
                    {t("saveDisplaySettings")}
                  </Button>
                </div>
              </section>
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
