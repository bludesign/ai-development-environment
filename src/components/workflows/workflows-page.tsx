"use client";

import {
  Archive,
  CirclePause,
  CirclePlay,
  Download,
  FilePenLine,
  FileUp,
  GitFork,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  Zap,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DateTime } from "@/components/common/date-time";
import { SelectAllCheckbox } from "@/components/common/select-all-checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link, useRouter } from "@/i18n/navigation";
import { downloadJsonFiles, exportFileStem } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { dayKey, formatDateValue } from "@/lib/date-format";
import {
  hasPrioritizedTableStatus,
  prioritizeActiveTableRows,
} from "@/lib/active-table-order";
import { isRowActivation, rowLinkClass } from "@/lib/row-activation";
import { cn } from "@/lib/utils";

import { WorkflowChoiceMenu } from "./workflow-choice-menu";
import { workflowStatusVariant } from "./workflow-graph";
import { useWorkflowLabels } from "./workflow-labels";
import type { WorkflowRun, WorkflowSummary } from "./types";

const WORKFLOW_FIELDS = `
  id name description draftDefinition activeVersionId enabled overlapPolicy maxConcurrentRuns completionNotificationsEnabled exclusiveWorktree archivedAt quickActionKind quickActionIconKey quickActionButtonVariant
  quickActionRepositories { id name displayOrigin }
  hasPlainTrigger
  triggerChoices { key label description }
  versionCount runCount createdAt updatedAt
`;

const RUN_FIELDS = `
  id displayNumber workflowId triggerKind triggerSubjectKey status phase generation
  blockedReason error queuedAt startedAt pausedAt finishedAt archivedAt createdAt
  workflow { id name }
  version { id workflowId version name description schemaVersion definition contentHash publishedAt }
`;

export function WorkflowsPage() {
  const t = useTranslations("workflows");
  const labels = useWorkflowLabels();
  const locale = useLocale();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  // Runs first: the page is checked far more often to see what automation did
  // overnight than to edit a definition.
  const [tab, setTab] = useState<"runs" | "workflows">("runs");
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [search, setSearch] = useState("");
  const [runArchiveFilter, setRunArchiveFilter] = useState("ACTIVE");
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [deleteWorkflowIds, setDeleteWorkflowIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        workflows: { items: WorkflowSummary[] };
        workflowRuns: { items: WorkflowRun[] };
      }>(
        `query WorkflowManagement($archive: String!) {
        workflows(first: 200) { items { ${WORKFLOW_FIELDS} } }
        workflowRuns(archive: $archive, first: 200) { items { ${RUN_FIELDS} } }
      }`,
        { archive: runArchiveFilter },
      );
      setWorkflows(data.workflows.items);
      setRuns(data.workflowRuns.items);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [runArchiveFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const subscriptions = controlPlaneSubscriptions();
    const dispose = subscriptions.subscribe<{
      workflowsChanged: { id: string } | null;
    }>(
      { query: "subscription WorkflowListChanges { workflowsChanged { id } }" },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(timer);
      dispose();
    };
  }, [load]);

  const filteredWorkflows = useMemo(
    () =>
      workflows.filter((workflow) =>
        `${workflow.name} ${workflow.description}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [search, workflows],
  );
  const filteredRuns = useMemo(
    () =>
      prioritizeActiveTableRows(
        runs.filter((run) =>
          `${run.displayNumber} ${run.workflow.name} ${run.status} ${run.triggerKind}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        ),
      ),
    [runs, search],
  );
  const runGroups = useMemo(() => {
    const result: Array<{
      key: string;
      value: string;
      prioritized: boolean;
      items: WorkflowRun[];
    }> = [];
    for (const run of filteredRuns) {
      const prioritized = hasPrioritizedTableStatus(run.status);
      const dateKey = dayKey(run.createdAt) ?? run.createdAt;
      const key = prioritized ? "priority" : dateKey;
      const group = result.at(-1);
      if (group?.key === key) group.items.push(run);
      else
        result.push({
          key,
          value: run.createdAt,
          prioritized,
          items: [run],
        });
    }
    return result;
  }, [filteredRuns]);

  const mutateRuns = async (
    query: string,
    variables: Record<string, unknown>,
  ) => {
    try {
      await controlPlaneRequest(query, variables);
      setSelected(new Set());
      setError(null);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const archiveRuns = (ids: string[], archived: boolean) =>
    mutateRuns(
      "mutation ArchiveWorkflowRuns($ids: [ID!]!, $archived: Boolean!) { archiveWorkflowRuns(ids: $ids, archived: $archived) }",
      { ids, archived },
    );
  const deleteRuns = (ids: string[]) =>
    mutateRuns(
      "mutation DeleteWorkflowRuns($ids: [ID!]!) { deleteWorkflowRuns(ids: $ids) }",
      { ids },
    );
  const toggleSelected = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const mutateWorkflow = async (
    workflow: WorkflowSummary,
    operation: "enabled" | "archive" | "run",
    choice: string | null = null,
  ) => {
    try {
      if (operation === "enabled") {
        await controlPlaneRequest(
          `mutation ToggleWorkflow($id: ID!, $enabled: Boolean!) { setWorkflowEnabled(id: $id, enabled: $enabled) { id } }`,
          { id: workflow.id, enabled: !workflow.enabled },
        );
      } else if (operation === "archive") {
        await controlPlaneRequest(
          `mutation ArchiveWorkflow($id: ID!) { archiveWorkflow(id: $id, archived: true) { id } }`,
          { id: workflow.id },
        );
      } else {
        const data = await controlPlaneRequest<{
          triggerWorkflow: { id: string };
        }>(
          `mutation TriggerWorkflow($input: TriggerWorkflowInput!) { triggerWorkflow(input: $input) { id } }`,
          { input: { workflowId: workflow.id, sessionData: {}, choice } },
        );
        router.push(`/workflows/runs/${data.triggerWorkflow.id}`);
      }
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  // Importing one file opens it for editing straight away; importing several
  // stays on the list, where the new cards are the useful result.
  const importWorkflows = async (files: File[]) => {
    const imported: string[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        const payload = JSON.parse(await file.text()) as unknown;
        const data = await controlPlaneRequest<{
          importWorkflow: { id: string };
        }>(
          `mutation ImportWorkflow($input: ImportWorkflowInput!) { importWorkflow(input: $input) { id } }`,
          { input: { payload } },
        );
        imported.push(data.importWorkflow.id);
      } catch (value) {
        // One unreadable file should not cost the user the rest of the batch,
        // and the message has to name it to be actionable.
        failures.push(
          `${file.name}: ${value instanceof Error ? value.message : String(value)}`,
        );
      }
    }
    setError(failures.length ? failures.join("\n") : null);
    if (files.length === 1 && imported.length === 1) {
      router.push(`/workflows/${imported[0]}/edit`);
      return;
    }
    if (imported.length) {
      setTab("workflows");
      await load();
    }
  };

  const exportWorkflows = async (ids: string[]) => {
    try {
      const files = await Promise.all(
        ids.map(async (id) => {
          const data = await controlPlaneRequest<{ exportWorkflow: unknown }>(
            `query ExportWorkflow($id: ID!) { exportWorkflow(id: $id) }`,
            { id },
          );
          const name =
            workflows.find((workflow) => workflow.id === id)?.name ?? id;
          return {
            value: data.exportWorkflow,
            filename: `${exportFileStem(name)}.workflow.json`,
          };
        }),
      );
      setError(null);
      await downloadJsonFiles(files);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  // `deleteWorkflow` refuses definitions with run history, so a partial
  // selection reports what stopped it while keeping the successes.
  const deleteWorkflows = async (ids: string[]) => {
    let failure: string | null = null;
    for (const id of ids) {
      try {
        await controlPlaneRequest(
          `mutation DeleteWorkflow($id: ID!) { deleteWorkflow(id: $id) }`,
          { id },
        );
      } catch (value) {
        failure ??= value instanceof Error ? value.message : String(value);
      }
    }
    setSelected(new Set());
    setError(failure);
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("descriptionLong")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            accept="application/json,.json"
            className="hidden"
            multiple
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              if (files.length) void importWorkflows(files);
              event.target.value = "";
            }}
            ref={fileRef}
            type="file"
          />
          <Button onClick={() => fileRef.current?.click()} variant="outline">
            <FileUp /> {t("import")}
          </Button>
          <Button asChild>
            <Link href="/workflows/new">
              <Plus /> {t("newWorkflow")}
            </Link>
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          {/* A batch import reports one line per file that failed. */}
          <AlertDescription className="whitespace-pre-line">
            {error}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          onValueChange={(value) => {
            setTab(value as "runs" | "workflows");
            setEditMode(false);
            setSelected(new Set());
          }}
          value={tab}
        >
          <TabsList>
            <TabsTrigger value="runs">{t("allRuns")}</TabsTrigger>
            <TabsTrigger value="workflows">{t("workflowsTab")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-64">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={t("search")}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("search")}
              value={search}
            />
          </InputGroup>
          {/* The archive filter only applies to runs, but both tabs support a
              multi-selection mode, so the edit toggle sits outside it. */}
          {tab === "runs" && (
            <Select
              onValueChange={(value) => {
                setRunArchiveFilter(value ?? "ACTIVE");
                setSelected(new Set());
              }}
              value={runArchiveFilter}
            >
              <SelectTrigger aria-label={t("archiveFilter")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">{t("active")}</SelectItem>
                <SelectItem value="ARCHIVED">{t("archived")}</SelectItem>
                <SelectItem value="ALL">{t("all")}</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Button
            onClick={() => {
              setEditMode((value) => !value);
              setSelected(new Set());
            }}
            variant="outline"
          >
            <FilePenLine /> {editMode ? t("done") : t("editRuns")}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={t("refresh")}
                onClick={() => void load()}
                size="icon"
                variant="outline"
              >
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("refresh")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {tab === "workflows" && editMode && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3">
          <SelectAllCheckbox
            ids={filteredWorkflows.map(({ id }) => id)}
            label={t("selectAll")}
            onChange={setSelected}
            selected={selected}
          />
          <span className="mr-auto text-sm text-muted-foreground">
            {t("selectedWorkflows", { count: selected.size })}
          </span>
          <Button
            disabled={selected.size === 0}
            onClick={() => void exportWorkflows([...selected])}
            size="sm"
            variant="outline"
          >
            <Download /> {t("export")}
          </Button>
          <Button
            disabled={selected.size === 0}
            onClick={() => setDeleteWorkflowIds([...selected])}
            size="sm"
            variant="destructive"
          >
            <Trash2 /> {t("delete")}
          </Button>
        </div>
      )}
      {tab === "runs" && editMode && selected.size > 0 && (
        <div className="flex flex-wrap gap-2 rounded-lg border bg-muted/30 p-3">
          <span className="mr-auto text-sm text-muted-foreground">
            {t("selectedRuns", { count: selected.size })}
          </span>
          <Button
            onClick={() =>
              void archiveRuns([...selected], runArchiveFilter !== "ARCHIVED")
            }
            size="sm"
            variant="outline"
          >
            {runArchiveFilter === "ARCHIVED" ? <Undo2 /> : <Archive />}{" "}
            {runArchiveFilter === "ARCHIVED" ? t("restore") : t("archive")}
          </Button>
          <Button
            onClick={() => setDeleteIds([...selected])}
            size="sm"
            variant="destructive"
          >
            <Trash2 /> {t("delete")}
          </Button>
        </div>
      )}

      {loading ? (
        tab === "runs" ? (
          <Card className="gap-0 overflow-hidden p-4">
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((item) => (
                <Skeleton className="h-8 w-full" key={item} />
              ))}
            </div>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {[0, 1, 2].map((item) => (
              <Card key={item}>
                <CardHeader>
                  <Skeleton className="h-5 w-2/5" />
                  <Skeleton className="h-4 w-4/5" />
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Skeleton className="h-5 w-16" />
                    <Skeleton className="h-5 w-20" />
                  </div>
                  <Skeleton className="h-8 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        )
      ) : tab === "workflows" ? (
        filteredWorkflows.length ? (
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {filteredWorkflows.map((workflow) => (
              <Card
                className={cn(
                  "cursor-pointer transition-colors hover:bg-muted/30",
                  editMode &&
                    selected.has(workflow.id) &&
                    "ring-2 ring-ring ring-offset-2 ring-offset-background",
                )}
                key={workflow.id}
                /* The whole card opens the workflow — in edit mode it is the
                   selection target instead, so it toggles rather than
                   navigating away mid-selection. The checkbox, menu, and links
                   inside it keep their own behaviour. */
                onClick={(event) => {
                  if (!isRowActivation(event)) return;
                  if (editMode) toggleSelected(workflow.id);
                  else router.push(`/workflows/${workflow.id}`);
                }}
              >
                {/* `CardAction` parks the menu in the header's own top-right
                    cell. Overriding the header to `flex-row` did not: the
                    header is a grid, so `flex-direction` never applied and the
                    menu dropped to a second row under the description. */}
                <CardHeader>
                  <CardTitle className="flex min-w-0 items-center gap-2">
                    {editMode && (
                      <Checkbox
                        aria-label={t("selectWorkflow", {
                          name: workflow.name,
                        })}
                        checked={selected.has(workflow.id)}
                        onCheckedChange={() => toggleSelected(workflow.id)}
                      />
                    )}
                    {/* The card itself carries the hover highlight and the
                        click target; the title stays a link only so keyboard
                        and middle-click users can still reach the workflow. */}
                    <Link
                      className="truncate"
                      href={`/workflows/${workflow.id}`}
                    >
                      {workflow.name}
                    </Link>
                  </CardTitle>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {workflow.description || t("noDescription")}
                  </p>
                  <CardAction>
                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <Button
                              aria-label={t("actions")}
                              size="icon"
                              variant="ghost"
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent>{t("actions")}</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/workflows/${workflow.id}/edit`}>
                            <Pencil /> {t("edit")}
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => void exportWorkflows([workflow.id])}
                        >
                          <Download /> {t("export")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            void mutateWorkflow(workflow, "enabled")
                          }
                        >
                          {workflow.enabled ? <CirclePause /> : <CirclePlay />}{" "}
                          {workflow.enabled
                            ? t("pauseDefinition")
                            : t("enable")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            void mutateWorkflow(workflow, "archive")
                          }
                        >
                          <Archive /> {t("archive")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardAction>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant={workflow.enabled ? "success" : "destructive"}
                    >
                      {workflow.enabled ? t("enabled") : t("disabled")}
                    </Badge>
                    <Badge variant="outline">
                      {t("versionCount", { count: workflow.versionCount })}
                    </Badge>
                    <Badge variant="outline">
                      {labels.overlapPolicy(workflow.overlapPolicy)}
                    </Badge>
                    {workflow.exclusiveWorktree && (
                      <Badge variant="outline">{t("exclusiveWorktree")}</Badge>
                    )}
                    {workflow.quickActionKind !== "NONE" && (
                      <Badge variant="outline">
                        <Zap /> {t("quickActions")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{t("runCount", { count: workflow.runCount })}</span>
                    <DateTime kind="relative" value={workflow.updatedAt} />
                  </div>
                  <div className="flex gap-2">
                    <Button asChild className="flex-1" variant="outline">
                      <Link href={`/workflows/${workflow.id}/edit`}>
                        <GitFork /> {t("edit")}
                      </Link>
                    </Button>
                    <WorkflowChoiceMenu
                      button={
                        <Button className="flex-1" disabled={!workflow.enabled}>
                          <CirclePlay /> {t("run")}
                        </Button>
                      }
                      choices={workflow.triggerChoices}
                      hasPlainTrigger={workflow.hasPlainTrigger}
                      onRun={(choice) =>
                        void mutateWorkflow(workflow, "run", choice)
                      }
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Empty className="border py-16">
            <EmptyHeader>
              <EmptyTitle>{t("empty")}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )
      ) : filteredRuns.length ? (
        <Card className="gap-0 overflow-hidden py-0">
          {/* A fixed layout divides the width between the columns instead of
              handing every spare pixel to the gaps, and the floor is the sum
              of what the columns actually need — below it the container
              scrolls rather than squeezing the run number into two lines. */}
          <Table
            className={cn(
              "table-fixed",
              editMode ? "min-w-[51rem]" : "min-w-[48rem]",
            )}
          >
            <TableHeader>
              <TableRow>
                {editMode && (
                  <TableHead className="w-10">
                    <SelectAllCheckbox
                      ids={filteredRuns.map(({ id }) => id)}
                      label={t("selectAll")}
                      onChange={setSelected}
                      selected={selected}
                    />
                  </TableHead>
                )}
                <TableHead className="w-[8%]">{t("run")}</TableHead>
                <TableHead className="w-[22%]">{t("workflow")}</TableHead>
                <TableHead className="w-[13%]">{t("status")}</TableHead>
                <TableHead className="w-[19%]">{t("trigger")}</TableHead>
                <TableHead className="w-[10%]">{t("generation")}</TableHead>
                <TableHead className="w-[16%]">{t("started")}</TableHead>
                <TableHead className="w-[12%] text-right">
                  {t("actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runGroups.map((group) => (
                <Fragment key={group.key}>
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    {editMode && (
                      <TableCell className="py-1.5">
                        <SelectAllCheckbox
                          ids={group.items.map(({ id }) => id)}
                          label={
                            group.prioritized
                              ? t("selectAll")
                              : t("selectDay", {
                                  day: formatDateValue(group.value, "long", {
                                    locale,
                                    showTime: false,
                                  }),
                                })
                          }
                          onChange={setSelected}
                          selected={selected}
                        />
                      </TableCell>
                    )}
                    <TableCell
                      className="py-1.5 text-xs font-normal text-muted-foreground"
                      colSpan={7}
                    >
                      {group.prioritized
                        ? t("active")
                        : formatDateValue(group.value, "long", {
                            locale,
                            showTime: false,
                          })}
                    </TableCell>
                  </TableRow>
                  {group.items.map((run) => (
                    <TableRow
                      className="cursor-pointer"
                      key={run.id}
                      /* Anything interactive inside the row — the workflow link,
                         a text selection drag — opts the row out, so only a click
                         on the row itself opens the run. In edit mode the row is
                         a selection target instead, so it toggles rather than
                         navigating away mid-selection. */
                      onClick={(event) => {
                        if (!isRowActivation(event)) return;
                        if (editMode) toggleSelected(run.id);
                        else router.push(`/workflows/runs/${run.id}`);
                      }}
                    >
                      {editMode && (
                        <TableCell>
                          <Checkbox
                            aria-label={t("selectRun", {
                              id: run.displayNumber,
                            })}
                            checked={selected.has(run.id)}
                            onCheckedChange={(checked) =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (checked) next.add(run.id);
                                else next.delete(run.id);
                                return next;
                              })
                            }
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <Link
                          className={cn(
                            rowLinkClass,
                            "inline-block font-mono font-medium",
                          )}
                          href={`/workflows/runs/${run.id}`}
                        >
                          #{run.displayNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          className={cn(rowLinkClass, "block min-w-0 truncate")}
                          href={`/workflows/${run.workflow.id}`}
                          title={run.workflow.name}
                        >
                          {run.workflow.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant={workflowStatusVariant(run.status)}>
                            {labels.status(run.status)}
                          </Badge>
                          {run.archivedAt && (
                            <Badge variant="outline">{t("archived")}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell
                        className="truncate"
                        title={labels.kind(run.triggerKind)}
                      >
                        {labels.kind(run.triggerKind)}
                      </TableCell>
                      <TableCell>{run.generation}</TableCell>
                      <TableCell>
                        {run.startedAt ? (
                          <DateTime
                            kind="time"
                            relativeToday
                            value={run.startedAt}
                          />
                        ) : (
                          t("queued")
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                aria-label={
                                  run.archivedAt ? t("restore") : t("archive")
                                }
                                onClick={() =>
                                  void archiveRuns([run.id], !run.archivedAt)
                                }
                                size="icon-sm"
                                variant="ghost"
                              >
                                {run.archivedAt ? <Undo2 /> : <Archive />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {run.archivedAt ? t("restore") : t("archive")}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                aria-label={t("delete")}
                                onClick={() => setDeleteIds([run.id])}
                                size="icon-sm"
                                variant="destructive"
                              >
                                <Trash2 />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t("delete")}</TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <Empty className="border py-16">
          <EmptyHeader>
            <EmptyTitle>{t("noRuns")}</EmptyTitle>
            <EmptyDescription>{t("descriptionLong")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <ConfirmationDialog
        actionLabel={t("delete")}
        cancelLabel={t("cancel")}
        description={t("deleteRunDescription")}
        onConfirm={() => void deleteRuns(deleteIds)}
        onOpenChange={(open) => {
          if (!open) setDeleteIds([]);
        }}
        open={deleteIds.length > 0}
        title={t("deleteRunTitle")}
      />
      <ConfirmationDialog
        actionLabel={t("delete")}
        cancelLabel={t("cancel")}
        description={t("deleteWorkflowDescription", {
          count: deleteWorkflowIds.length,
        })}
        onConfirm={() => void deleteWorkflows(deleteWorkflowIds)}
        onOpenChange={(open) => {
          if (!open) setDeleteWorkflowIds([]);
        }}
        open={deleteWorkflowIds.length > 0}
        title={t("deleteWorkflowTitle")}
      />
    </div>
  );
}
