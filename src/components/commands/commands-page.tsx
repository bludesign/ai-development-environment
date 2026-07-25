"use client";

import {
  Archive,
  CircleStop,
  FilePenLine,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  TerminalSquare,
  Trash2,
  Undo2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DateTime } from "@/components/common/date-time";
import { SelectAllCheckbox } from "@/components/common/select-all-checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link, useRouter } from "@/i18n/navigation";
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
import { worktreeHighlightBackgroundClasses } from "@/lib/worktree-highlight";

import { CommandTargetDialog } from "./command-target-dialog";
import {
  COMMAND_DEFINITION_FIELDS,
  COMMAND_RUN_FIELDS,
  activeCommandRun,
  commandRestartKey,
  commandStatusKey,
  commandTargetKey,
  type CommandAgent,
  type CommandDefinition,
  type CommandRun,
  type CommandWorktree,
} from "./types";

const statusVariant = (status: string) =>
  status === "SUCCEEDED"
    ? "default"
    : status === "FAILED" || status === "CANCELLED"
      ? "destructive"
      : "secondary";

export function CommandsPage() {
  const t = useTranslations("commands");
  const locale = useLocale();
  const router = useRouter();
  const [tab, setTab] = useState<"runs" | "definitions">("runs");
  const [definitions, setDefinitions] = useState<CommandDefinition[]>([]);
  const [runs, setRuns] = useState<CommandRun[]>([]);
  const [agents, setAgents] = useState<CommandAgent[]>([]);
  const [worktrees, setWorktrees] = useState<CommandWorktree[]>([]);
  const [search, setSearch] = useState("");
  const [archive, setArchive] = useState("ACTIVE");
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [targetCommand, setTargetCommand] = useState<CommandDefinition | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeRunKey = useMemo(
    () =>
      runs
        .filter((run) => activeCommandRun(run.status))
        .map((run) => run.id)
        .join("|"),
    [runs],
  );

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        commandDefinitions: CommandDefinition[];
        commandRuns: { nodes: CommandRun[] };
        agents: CommandAgent[];
        worktreeOverview: {
          agents: Array<{
            agent: CommandAgent;
            codebases: Array<{
              repository: { id: string; name: string };
              worktrees: CommandWorktree[];
            }>;
          }>;
        };
      }>(
        `query CommandManagement($includeArchived: Boolean!) {
        commandDefinitions(includeArchived: true) { ${COMMAND_DEFINITION_FIELDS} }
        commandRuns(includeArchived: $includeArchived, first: 200) { nodes { ${COMMAND_RUN_FIELDS} } }
        agents { id name hostname connectionStatus capabilities }
        worktreeOverview {
          agents { agent { id name hostname connectionStatus capabilities }
            codebases { repository { id name } worktrees { id folder branch highlightColor } }
          }
        }
      }`,
        { includeArchived: archive !== "ACTIVE" },
      );
      setDefinitions(data.commandDefinitions);
      setRuns(
        data.commandRuns.nodes.filter((run) =>
          archive === "ARCHIVED"
            ? Boolean(run.archivedAt)
            : archive === "ACTIVE"
              ? !run.archivedAt
              : true,
        ),
      );
      setAgents(data.agents);
      setWorktrees(
        data.worktreeOverview.agents.flatMap((group) =>
          group.codebases.flatMap((codebase) =>
            codebase.worktrees.map((worktree) => ({
              ...worktree,
              repositoryId: codebase.repository.id,
              repositoryName: codebase.repository.name,
              agentId: group.agent.id,
              agentName: group.agent.name,
            })),
          ),
        ),
      );
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [archive]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const client = controlPlaneSubscriptions();
    const disposers = [
      client.subscribe(
        { query: "subscription CommandsChanged { commandsChanged { id } }" },
        {
          next: () => void load(),
          error: () => undefined,
          complete: () => undefined,
        },
      ),
      ...activeRunKey
        .split("|")
        .filter(Boolean)
        .map((runId) =>
          client.subscribe(
            {
              query: `subscription CommandRunChanged($runId: ID!) { commandRunChanged(runId: $runId) { id status updatedAt } }`,
              variables: { runId },
            },
            {
              next: () => void load(),
              error: () => undefined,
              complete: () => undefined,
            },
          ),
        ),
    ];
    return () => {
      window.clearTimeout(initialLoad);
      disposers.forEach((dispose) => dispose());
    };
  }, [activeRunKey, load]);

  const filteredRuns = useMemo(
    () =>
      prioritizeActiveTableRows(
        runs.filter((run) =>
          `${run.displayNumber} ${run.snapshotName} ${run.agentName} ${run.worktreePath ?? ""} ${run.status}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        ),
      ),
    [runs, search],
  );
  const groups = useMemo(() => {
    const result: Array<{
      key: string;
      date: string;
      prioritized: boolean;
      runs: CommandRun[];
    }> = [];
    for (const run of filteredRuns) {
      const prioritized = hasPrioritizedTableStatus(run.status);
      const dateKey = dayKey(run.createdAt) ?? run.createdAt;
      const key = prioritized ? "priority" : dateKey;
      const current = result.at(-1);
      if (current?.key === key) current.runs.push(run);
      else
        result.push({
          key,
          date: run.createdAt,
          prioritized,
          runs: [run],
        });
    }
    return result;
  }, [filteredRuns]);
  const filteredDefinitions = definitions.filter((definition) =>
    `${definition.name} ${definition.description} ${definition.targetKind}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  const mutate = async (query: string, variables: Record<string, unknown>) => {
    try {
      await controlPlaneRequest(query, variables);
      setSelected(new Set());
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const launch = async (
    command: CommandDefinition,
    target: { agentId?: string; worktreeId?: string },
  ) => {
    try {
      const data = await controlPlaneRequest<{
        startCommandRun: { id: string };
      }>(
        "mutation StartCommand($input: StartCommandRunInput!) { startCommandRun(input: $input) { id } }",
        { input: { commandId: command.id, origin: "MANUAL", ...target } },
      );
      setTargetCommand(null);
      router.push(`/commands/runs/${data.startCommandRun.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Button asChild>
          <Link href="/commands/new">
            <Plus />
            {t("newCommand")}
          </Link>
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as typeof tab)}
        >
          <TabsList>
            <TabsTrigger value="runs">{t("runs")}</TabsTrigger>
            <TabsTrigger value="definitions">{t("definitions")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              className="w-64 pl-8"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("search")}
            />
          </div>
          {tab === "runs" && (
            <>
              <Select
                value={archive}
                onValueChange={(value) => setArchive(value ?? "ACTIVE")}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">{t("active")}</SelectItem>
                  <SelectItem value="ARCHIVED">{t("archived")}</SelectItem>
                  <SelectItem value="ALL">{t("all")}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={() => {
                  setEditMode(!editMode);
                  setSelected(new Set());
                }}
              >
                <FilePenLine />
                {editMode ? t("done") : t("edit")}
              </Button>
            </>
          )}
          <Button
            aria-label={t("refresh")}
            size="icon"
            variant="outline"
            onClick={() => void load()}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>

      {tab === "runs" && editMode && selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-lg border p-3">
          <span className="mr-auto text-sm text-muted-foreground">
            {t("selected", { count: selected.size })}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void mutate(
                "mutation Archive($ids: [ID!]!, $archived: Boolean!) { archiveCommandRuns(ids: $ids, archived: $archived) }",
                { ids: [...selected], archived: archive !== "ARCHIVED" },
              )
            }
          >
            {archive === "ARCHIVED" ? <Undo2 /> : <Archive />}
            {archive === "ARCHIVED" ? t("restore") : t("archive")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDeleteIds([...selected])}
          >
            <Trash2 />
            {t("delete")}
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
      ) : tab === "runs" ? (
        <Card className="gap-0 overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {editMode && (
                  <TableHead className="w-10">
                    <SelectAllCheckbox
                      ids={filteredRuns
                        .filter((run) => !activeCommandRun(run.status))
                        .map((run) => run.id)}
                      label={t("selectAll")}
                      onChange={setSelected}
                      selected={selected}
                    />
                  </TableHead>
                )}
                <TableHead>{t("number")}</TableHead>
                <TableHead>{t("command")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>{t("agent")}</TableHead>
                <TableHead>{t("worktree")}</TableHead>
                <TableHead>{t("started")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    {editMode && (
                      <TableCell className="py-2">
                        {!group.prioritized && (
                          <SelectAllCheckbox
                            ids={group.runs
                              .filter((run) => !activeCommandRun(run.status))
                              .map((run) => run.id)}
                            label={t("selectDay", {
                              day: formatDateValue(group.date, "long", {
                                locale,
                                showTime: false,
                              }),
                            })}
                            onChange={setSelected}
                            selected={selected}
                          />
                        )}
                      </TableCell>
                    )}
                    <TableCell
                      colSpan={7}
                      className="py-2 text-xs font-medium text-muted-foreground"
                    >
                      {group.prioritized
                        ? t("active")
                        : formatDateValue(group.date, "long", {
                            locale,
                            showTime: false,
                          })}
                    </TableCell>
                  </TableRow>
                  {group.runs.map((run) => (
                    <TableRow
                      className={cn(
                        "cursor-pointer",
                        worktreeHighlightBackgroundClasses[
                          run.worktree?.highlightColor ?? ""
                        ],
                      )}
                      key={run.id}
                      onClick={(event) => {
                        if (!isRowActivation(event)) return;
                        if (editMode) {
                          if (activeCommandRun(run.status)) return;
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(run.id)) next.delete(run.id);
                            else next.add(run.id);
                            return next;
                          });
                        } else {
                          router.push(`/commands/runs/${run.id}`);
                        }
                      }}
                    >
                      {editMode && (
                        <TableCell>
                          <Checkbox
                            checked={selected.has(run.id)}
                            disabled={activeCommandRun(run.status)}
                            onCheckedChange={() =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (next.has(run.id)) next.delete(run.id);
                                else next.add(run.id);
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
                            "inline-block font-mono text-xs",
                          )}
                          href={`/commands/runs/${run.id}`}
                        >
                          #{run.displayNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          className={cn(
                            rowLinkClass,
                            "inline-block font-medium",
                          )}
                          href={`/commands/runs/${run.id}`}
                        >
                          {run.snapshotName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(run.status)}>
                          {t(commandStatusKey(run.status))}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {run.agentId ? (
                          <Link
                            className={cn(rowLinkClass, "inline-block")}
                            href={`/agents/${run.agentId}`}
                          >
                            {run.agentName}
                          </Link>
                        ) : (
                          run.agentName
                        )}
                      </TableCell>
                      <TableCell>
                        {run.worktreeId ? (
                          <Link
                            className={cn(
                              rowLinkClass,
                              "inline-block max-w-48 truncate",
                            )}
                            href={`/worktrees/${run.worktreeId}`}
                          >
                            {run.worktreeBranch || run.worktreePath}
                          </Link>
                        ) : run.snapshotTargetKind.includes("WORKTREE") ? (
                          <span className="text-muted-foreground">
                            {run.worktreeBranch ||
                              run.worktreePath ||
                              t("targetUnavailable")}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {t("home")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <DateTime
                          kind="time"
                          relativeToday
                          value={run.startedAt ?? run.queuedAt}
                        />
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost">
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {activeCommandRun(run.status) ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  void mutate(
                                    "mutation Stop($id: ID!) { terminateCommandRun(id: $id) { id } }",
                                    { id: run.id },
                                  )
                                }
                              >
                                <CircleStop />
                                {t("terminate")}
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onClick={async () => {
                                  const data = await controlPlaneRequest<{
                                    rerunCommandRun: { id: string };
                                  }>(
                                    "mutation Rerun($id: ID!) { rerunCommandRun(id: $id) { id } }",
                                    { id: run.id },
                                  );
                                  router.push(
                                    `/commands/runs/${data.rerunCommandRun.id}`,
                                  );
                                }}
                              >
                                <RotateCcw />
                                {t("rerun")}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
              {filteredRuns.length === 0 && (
                <TableRow>
                  <TableCell
                    className="h-32 text-center text-muted-foreground"
                    colSpan={8}
                  >
                    {t("noRuns")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {filteredDefinitions.map((definition) => (
            <Card
              key={definition.id}
              className={definition.archivedAt ? "opacity-60" : ""}
            >
              <CardHeader>
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-muted p-2">
                    <TerminalSquare />
                  </div>
                  <div className="min-w-0 flex-1">
                    <CardTitle>{definition.name}</CardTitle>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {definition.description || t("noDescription")}
                    </p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">
                    {t(commandTargetKey(definition.targetKind))}
                  </Badge>
                  <Badge variant="outline">
                    {t(commandRestartKey(definition.restartPolicy))}
                  </Badge>
                  {definition.quickActionEnabled && (
                    <Badge>{t("quickAction")}</Badge>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={Boolean(definition.archivedAt)}
                    onClick={() => setTargetCommand(definition)}
                  >
                    <Play />
                    {t("run")}
                  </Button>
                  <Button asChild variant="outline">
                    <Link href={`/commands/${definition.id}/edit`}>
                      <FilePenLine />
                      {t("edit")}
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CommandTargetDialog
        command={targetCommand}
        agents={agents}
        worktrees={worktrees}
        open={Boolean(targetCommand)}
        onOpenChange={(open) => {
          if (!open) setTargetCommand(null);
        }}
        onSelect={(target) => {
          if (targetCommand) void launch(targetCommand, target);
        }}
      />
      <ConfirmationDialog
        open={deleteIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleteIds([]);
        }}
        title={t("deleteRunsTitle")}
        description={t("deleteRunsDescription")}
        actionLabel={t("delete")}
        cancelLabel={t("cancel")}
        onConfirm={() =>
          void mutate(
            "mutation Delete($ids: [ID!]!) { deleteCommandRuns(ids: $ids) }",
            { ids: deleteIds },
          )
        }
      />
    </div>
  );
}
