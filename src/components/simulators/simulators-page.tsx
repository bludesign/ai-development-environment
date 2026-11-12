"use client";

import { canDeleteSimulator } from "@ai-development-environment/agent-contract/simulators";
import {
  ListFilter,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  TabletSmartphone,
  Trash2,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import {
  useActiveAgent,
  usePageAgentFilter,
  type ActiveAgentOption,
} from "@/components/active-agent/active-agent-provider";
import {
  ALL_PAGE_AGENTS,
  PageAgentFilter,
} from "@/components/active-agent/page-agent-filter";
import { SelectAllCheckbox } from "@/components/common/select-all-checkbox";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { rowLinkClass } from "@/lib/row-activation";
import { cn } from "@/lib/utils";

import { SimulatorFleetDialog } from "./simulator-fleet-dialog";
import {
  createSimulator,
  performSimulatorAction,
  refreshSimulatorInventory,
  resetSimulators,
  simulatorAgentSupports,
  simulatorHref,
  type CreateSimulatorInput,
  type Simulator,
  type SimulatorAction,
  type SimulatorInventory,
  type SimulatorPlatform,
} from "./simulator-client";
import { SimulatorStateBadge } from "./simulator-state-badge";

type SimulatorRow = {
  agent: ActiveAgentOption;
  simulator: Simulator;
  deviceTypeName: string | undefined;
};

type DeleteFailure = { row: SimulatorRow; message: string };
type DeleteBatchResult = { agentIds: string[]; failures: DeleteFailure[] };

function simulatorRowKey({ agent, simulator }: SimulatorRow) {
  return `${agent.id}:${simulator.id}`;
}

async function deleteSimulatorGroups(groups: SimulatorRow[][]) {
  // Confirmed writes keep their original targets when the visible agent changes.
  const { signal } = new AbortController();
  const failures: DeleteFailure[] = [];
  const concurrentAgents = 4;
  for (let offset = 0; offset < groups.length; offset += concurrentAgents) {
    await Promise.all(
      groups.slice(offset, offset + concurrentAgents).map(async (rows) => {
        for (const row of rows) {
          try {
            await performSimulatorAction(
              {
                agentId: row.agent.id,
                simulatorId: row.simulator.id,
                action: "DELETE",
              },
              signal,
            );
          } catch (error) {
            failures.push({
              row,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }),
    );
  }
  return failures;
}

export function SimulatorsPage({
  initialPlatform = "APPLE",
}: { initialPlatform?: SimulatorPlatform } = {}) {
  const t = useTranslations("simulators");
  const [platform, setPlatform] = useState(initialPlatform);
  const { activeAgentId, agents, loading, ready, error } = useActiveAgent();
  const [selection, setSelection] = usePageAgentFilter(
    "simulators",
    ALL_PAGE_AGENTS,
  );
  const agentId =
    activeAgentId ?? (selection === ALL_PAGE_AGENTS ? null : selection);
  const [deleting, setDeleting] = useState(false);
  const [completedDeletion, setCompletedDeletion] =
    useState<DeleteBatchResult | null>(null);

  async function deleteBatch(groups: SimulatorRow[][]) {
    setDeleting(true);
    try {
      setCompletedDeletion({
        agentIds: groups.map((rows) => rows[0]!.agent.id),
        failures: await deleteSimulatorGroups(groups),
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            disabled={deleting}
            value={platform}
            onValueChange={(value) => {
              setPlatform(value === "ANDROID" ? "ANDROID" : "APPLE");
              setCompletedDeletion(null);
            }}
          >
            <SelectTrigger aria-label={t("simulatorFamily")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="APPLE">{t("appleSimulators")}</SelectItem>
              <SelectItem value="ANDROID">{t("androidEmulators")}</SelectItem>
            </SelectContent>
          </Select>
          <PageAgentFilter value={selection} onValueChange={setSelection} />
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {deleting && (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner /> {t("deletingSelected")}
        </p>
      )}
      {!deleting && Boolean(completedDeletion?.failures.length) && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{t("deleteFailures")}</p>
            <ul className="list-disc pl-4">
              {completedDeletion?.failures.map(({ row, message }) => (
                <li key={simulatorRowKey(row)}>
                  {t("deleteFailure", {
                    name: row.simulator.name,
                    agent: row.agent.name,
                    message,
                  })}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {ready && (!loading || agents.length > 0) ? (
        <SimulatorList
          completedDeletion={completedDeletion}
          deleting={deleting}
          key={`${platform}:${agentId ?? ALL_PAGE_AGENTS}`}
          simulatorFamily={platform}
          agents={
            agentId ? agents.filter((agent) => agent.id === agentId) : agents
          }
          onDelete={deleteBatch}
        />
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      )}
    </section>
  );
}

function SimulatorList({
  agents,
  completedDeletion,
  deleting,
  onDelete,
  simulatorFamily,
}: {
  agents: ActiveAgentOption[];
  completedDeletion: DeleteBatchResult | null;
  deleting: boolean;
  onDelete: (groups: SimulatorRow[][]) => Promise<void>;
  simulatorFamily: SimulatorPlatform;
}) {
  const t = useTranslations("simulators");
  const tc = useTranslations("common");
  const locale = useLocale();
  const eligibleIds = agents
    .filter((agent) =>
      simulatorAgentSupports(agent, "inventory", simulatorFamily),
    )
    .map(({ id }) => id)
    .join("\0");
  const [inventories, setInventories] = useState<
    Record<string, SimulatorInventory>
  >({});
  const [agentErrors, setAgentErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [refreshingAgents, setRefreshingAgents] = useState(
    () => new Set(eligibleIds ? eligibleIds.split("\0") : []),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("all");
  const [state, setState] = useState("all");
  const [dialog, setDialog] = useState<"create" | "reset" | null>(null);
  const [deletion, setDeletion] = useState<SimulatorRow | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [selection, setSelection] = useState<{
    result: DeleteBatchResult | null;
    keys: Set<string>;
  } | null>(null);
  const [bulkDeletion, setBulkDeletion] = useState<Set<string> | null>(null);
  const inventoryRequests = useRef(new Map<string, AbortController>());
  const operationRequest = useRef<AbortController | null>(null);
  const [reconciledDeletion, setReconciledDeletion] =
    useState(completedDeletion);
  const selected =
    selection?.result === completedDeletion
      ? selection.keys
      : new Set(
          completedDeletion?.failures.map(({ row }) => simulatorRowKey(row)),
        );
  const setSelected = (keys: Set<string>) =>
    setSelection({ result: completedDeletion, keys });
  const operationsBusy = busy || deleting;
  const refreshing = refreshingAgents.size > 0;
  const pendingReconciliation =
    completedDeletion !== reconciledDeletion ? completedDeletion : null;
  const inventoryPending = (agentId: string) =>
    refreshingAgents.has(agentId) ||
    Boolean(pendingReconciliation?.agentIds.includes(agentId));
  const inventoryReady = (agentId: string) =>
    Boolean(inventories[agentId]) &&
    !agentErrors[agentId] &&
    !inventoryPending(agentId);
  const refreshableIds = eligibleIds
    ? eligibleIds.split("\0").filter((id) => !inventoryPending(id))
    : [];
  const refresh = useCallback(
    async (onlyAgentIds?: string[]) => {
      const agentIds = eligibleIds ? eligibleIds.split("\0") : [];
      const targets = onlyAgentIds
        ? agentIds.filter((id) => onlyAgentIds.includes(id))
        : agentIds;
      setRefreshingAgents(
        new Set([...inventoryRequests.current.keys(), ...targets]),
      );
      await Promise.all(
        targets.map(async (id) => {
          inventoryRequests.current.get(id)?.abort();
          const controller = new AbortController();
          inventoryRequests.current.set(id, controller);
          try {
            const result = await refreshSimulatorInventory(
              id,
              controller.signal,
              simulatorFamily === "ANDROID" ? simulatorFamily : undefined,
            );
            if (controller.signal.aborted) return;
            setInventories((current) => ({ ...current, [id]: result }));
            setAgentErrors((current) => ({ ...current, [id]: undefined }));
          } catch (value) {
            if (controller.signal.aborted) return;
            setAgentErrors((current) => ({
              ...current,
              [id]: value instanceof Error ? value.message : String(value),
            }));
          } finally {
            if (inventoryRequests.current.get(id) === controller) {
              inventoryRequests.current.delete(id);
              setRefreshingAgents(new Set(inventoryRequests.current.keys()));
            }
          }
        }),
      );
    },
    [eligibleIds, simulatorFamily],
  );

  useEffect(() => {
    const requests = inventoryRequests.current;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timer);
      for (const controller of requests.values()) controller.abort();
      requests.clear();
    };
  }, [refresh]);

  useEffect(() => {
    if (!completedDeletion || reconciledDeletion === completedDeletion) return;
    const timer = window.setTimeout(() => {
      setReconciledDeletion(completedDeletion);
      void refresh(completedDeletion.agentIds);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [completedDeletion, reconciledDeletion, refresh]);

  useEffect(() => () => operationRequest.current?.abort(), []);

  async function run(
    agentIds: string[],
    action: (signal: AbortSignal) => Promise<unknown>,
  ) {
    const controller = new AbortController();
    operationRequest.current = controller;
    setBusy(true);
    setError(null);
    try {
      await action(controller.signal);
    } finally {
      if (!controller.signal.aborted) {
        void refresh(agentIds);
        setBusy(false);
      }
    }
  }

  const runRowAction = async (
    { agent, simulator }: SimulatorRow,
    action: SimulatorAction,
  ) => {
    try {
      await run([agent.id], (signal) =>
        performSimulatorAction(
          { agentId: agent.id, simulatorId: simulator.id, action },
          signal,
        ),
      );
    } catch (value) {
      if (!operationRequest.current?.signal.aborted)
        setError(value instanceof Error ? value.message : String(value));
    }
  };

  const rows = agents.flatMap((agent) => {
    const inventory = inventories[agent.id];
    if (!inventory) return [];
    const typeNames = new Map(
      inventory.runtimes.flatMap((runtime) =>
        runtime.deviceTypes.map(({ id, name }) => [id, name] as const),
      ),
    );
    return inventory.simulators.map((simulator) => ({
      agent,
      simulator,
      deviceTypeName: typeNames.get(simulator.deviceTypeId ?? ""),
    }));
  });
  const platforms = [
    ...new Set(rows.map(({ simulator }) => simulator.platform)),
  ].sort();
  const query = search.trim().toLocaleLowerCase(locale);
  const filtered = rows
    .filter(
      ({ agent, simulator, deviceTypeName }) =>
        (platform === "all" || simulator.platform === platform) &&
        (state === "all" ||
          (simulator.isAvailable
            ? simulator.state.toLowerCase()
            : "unavailable") === state) &&
        (!query ||
          [
            agent.name,
            simulator.name,
            simulator.runtimeName,
            simulator.platform,
            simulator.id,
            deviceTypeName,
          ].some((value) => value?.toLocaleLowerCase(locale).includes(query))),
    )
    .sort(
      (a, b) =>
        a.simulator.platform.localeCompare(b.simulator.platform, locale) ||
        (b.simulator.runtimeName ?? "").localeCompare(
          a.simulator.runtimeName ?? "",
          locale,
          { numeric: true },
        ) ||
        a.simulator.name.localeCompare(b.simulator.name, locale) ||
        a.agent.name.localeCompare(b.agent.name, locale),
    );

  const createAgents = agents.filter(
    (agent) =>
      simulatorAgentSupports(agent, "create", simulatorFamily) &&
      inventoryReady(agent.id),
  );
  const resetAgents = agents.filter(
    (agent) =>
      simulatorAgentSupports(agent, "reset", simulatorFamily) &&
      inventoryReady(agent.id),
  );
  const noMatchingRows = rows.length > 0 && filtered.length === 0;
  const groups = agents
    .map((agent) => ({
      agent,
      rows: filtered.filter((row) => row.agent.id === agent.id),
    }))
    .filter((group) => group.rows.length > 0);
  const canDelete = ({ agent, simulator }: SimulatorRow) =>
    !agentErrors[agent.id] &&
    simulatorAgentSupports(agent, "action", simulatorFamily) &&
    canDeleteSimulator(simulator);
  const selectedRows = filtered.filter(
    (row) => canDelete(row) && selected.has(simulatorRowKey(row)),
  );
  const selectedVisible = new Set(selectedRows.map(simulatorRowKey));
  const selectedInventoryPending = selectedRows.some(({ agent }) =>
    inventoryPending(agent.id),
  );

  function changeFilter(setFilter: (value: string) => void, value: string) {
    setFilter(value);
    setSelected(new Set());
  }

  function toggleEditMode() {
    setEditMode(!editMode);
    if (editMode) setSelected(new Set());
  }

  function canConfirmDelete(row: SimulatorRow) {
    return (
      canDelete(row) &&
      !inventoryPending(row.agent.id) &&
      !inventoryRequests.current.has(row.agent.id)
    );
  }

  async function deleteSelected(targets: Set<string>) {
    const targetGroups = groups
      .map(({ rows }) =>
        rows.filter(
          (row) => targets.has(simulatorRowKey(row)) && canConfirmDelete(row),
        ),
      )
      .filter((rows) => rows.length > 0);
    if (operationsBusy || targetGroups.flat().length !== targets.size) {
      setError(t("selectionChanged"));
      return;
    }
    setError(null);
    await onDelete(targetGroups);
  }

  async function deleteOne(target: SimulatorRow) {
    const row = rows.find(
      (row) => simulatorRowKey(row) === simulatorRowKey(target),
    );
    if (operationsBusy || !row || !canConfirmDelete(row)) {
      setError(t("selectionChanged"));
      return;
    }
    await runRowAction(row, "DELETE");
  }

  return (
    <>
      <div className="flex flex-wrap items-start gap-2">
        <div className="relative w-full sm:mr-auto sm:w-auto sm:min-w-56 sm:flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label={t("search")}
            className="pl-9"
            disabled={operationsBusy}
            onChange={(event) => changeFilter(setSearch, event.target.value)}
            placeholder={t("search")}
            value={search}
          />
        </div>
        <Select
          disabled={operationsBusy}
          onValueChange={(value) => changeFilter(setPlatform, value)}
          value={platform}
        >
          <SelectTrigger aria-label={t("platform")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allPlatforms")}</SelectItem>
            {platforms.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          disabled={operationsBusy}
          onValueChange={(value) => changeFilter(setState, value)}
          value={state}
        >
          <SelectTrigger aria-label={t("state")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allStates")}</SelectItem>
            <SelectItem value="booted">{t("booted")}</SelectItem>
            <SelectItem value="shutdown">{t("shutDown")}</SelectItem>
            <SelectItem value="unavailable">{t("unavailable")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          disabled={operationsBusy || !refreshableIds.length}
          onClick={() => void refresh(refreshableIds)}
          variant="outline"
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />{" "}
          {t("refresh")}
        </Button>
        <Button
          disabled={operationsBusy || (!editMode && !filtered.length)}
          onClick={toggleEditMode}
          variant={editMode ? "default" : "outline"}
        >
          {editMode ? <X /> : <ListFilter />} {t(editMode ? "done" : "edit")}
        </Button>
        {simulatorFamily === "APPLE" && (
          <Button
            disabled={editMode || operationsBusy || !resetAgents.length}
            onClick={() => setDialog("reset")}
            variant="outline"
          >
            {t("reset")}
          </Button>
        )}
        <Button
          disabled={editMode || operationsBusy || !createAgents.length}
          onClick={() => setDialog("create")}
        >
          <Plus />{" "}
          {t(simulatorFamily === "ANDROID" ? "createEmulator" : "create")}
        </Button>
      </div>

      {editMode && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2">
          <span className="text-xs text-muted-foreground" role="status">
            {t("selectedCount", { count: selectedVisible.size })}
          </span>
          <Button
            disabled={
              operationsBusy ||
              selectedInventoryPending ||
              !selectedVisible.size
            }
            onClick={() => setBulkDeletion(selectedVisible)}
            size="sm"
            variant="destructive"
          >
            {deleting ? <Spinner /> : <Trash2 />} {t("deleteSelected")}
          </Button>
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {agents.map((agent) => {
        const message =
          agent.connectionStatus !== "ONLINE"
            ? t("offline")
            : !simulatorAgentSupports(agent, "inventory", simulatorFamily)
              ? t(
                  simulatorFamily === "ANDROID"
                    ? "androidToolsRequired"
                    : "agentUpdateRequired",
                )
              : agentErrors[agent.id];
        return (
          message && (
            <Alert key={agent.id}>
              <AlertDescription>
                {agent.name} · {message}
              </AlertDescription>
            </Alert>
          )
        );
      })}

      {refreshing && (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner /> {t("loading")}
        </p>
      )}
      {filtered.length > 0 ? (
        <Card className="gap-0 py-0">
          <Table>
            <TableHeader>
              <TableRow>
                {editMode && (
                  <TableHead className="w-10">
                    <span className="sr-only">{t("selection")}</span>
                  </TableHead>
                )}
                <TableHead>{t("name")}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t("runtime")}
                </TableHead>
                <TableHead>{t("state")}</TableHead>
                {!editMode && (
                  <TableHead className="w-10">
                    <span className="sr-only">{t("actions")}</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map(({ agent, rows }) => (
                <Fragment key={agent.id}>
                  <TableRow className="bg-muted/35 hover:bg-muted/35">
                    {editMode && (
                      <TableCell className="px-2 py-1.5">
                        <SelectAllCheckbox
                          disabled={
                            operationsBusy || inventoryPending(agent.id)
                          }
                          ids={rows.filter(canDelete).map(simulatorRowKey)}
                          label={t("selectAllAgent", { agent: agent.name })}
                          onChange={setSelected}
                          selected={selectedVisible}
                        />
                      </TableCell>
                    )}
                    <TableCell
                      className="px-3 py-1.5 font-medium"
                      colSpan={editMode ? 3 : 4}
                    >
                      <Link
                        className={rowLinkClass}
                        href={`/dashboard/agents/${encodeURIComponent(agent.id)}`}
                      >
                        {agent.name}
                      </Link>
                    </TableCell>
                  </TableRow>
                  {rows.map((row) => {
                    const { agent, simulator, deviceTypeName } = row;
                    const agentBusy =
                      operationsBusy || inventoryPending(agent.id);
                    const canAct =
                      !agentBusy &&
                      !agentErrors[agent.id] &&
                      simulatorAgentSupports(agent, "action", simulatorFamily);
                    const booted = simulator.state.toLowerCase() === "booted";
                    const shutDown =
                      simulator.state.toLowerCase() === "shutdown";
                    const deletable = canDeleteSimulator(simulator);
                    const key = simulatorRowKey(row);
                    const isSelected = selectedVisible.has(key);
                    return (
                      <TableRow
                        data-state={isSelected ? "selected" : undefined}
                        key={key}
                      >
                        {editMode && (
                          <TableCell>
                            <Checkbox
                              aria-label={t("selectSimulator", {
                                name: simulator.name,
                              })}
                              checked={isSelected}
                              disabled={agentBusy || !canDelete(row)}
                              onCheckedChange={(checked) => {
                                const next = new Set(selectedVisible);
                                if (checked === true) next.add(key);
                                else next.delete(key);
                                setSelected(next);
                              }}
                              title={
                                !deletable
                                  ? t("deleteNeedsShutdown")
                                  : undefined
                              }
                            />
                          </TableCell>
                        )}
                        <TableCell className="min-w-32 whitespace-normal">
                          <Link
                            className={cn(
                              rowLinkClass,
                              "inline-block font-medium",
                            )}
                            href={simulatorHref(agent.id, simulator.id)}
                          >
                            {simulator.name}
                          </Link>
                          {deviceTypeName &&
                            deviceTypeName !== simulator.name && (
                              <p className="text-xs text-muted-foreground">
                                {deviceTypeName}
                              </p>
                            )}
                          <p className="text-xs text-muted-foreground sm:hidden">
                            {simulator.runtimeName ?? simulator.platform}
                          </p>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {simulator.runtimeName ?? simulator.platform}
                        </TableCell>
                        <TableCell>
                          <SimulatorStateBadge simulator={simulator} />
                        </TableCell>
                        {!editMode && (
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {simulator.isAvailable &&
                                (booted || shutDown) && (
                                  <Button
                                    disabled={!canAct}
                                    onClick={() =>
                                      void runRowAction(
                                        row,
                                        booted ? "SHUTDOWN" : "BOOT",
                                      )
                                    }
                                    size="sm"
                                    variant="outline"
                                  >
                                    {t(booted ? "shutdown" : "boot")}
                                  </Button>
                                )}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    aria-label={t("actionsFor", {
                                      name: simulator.name,
                                    })}
                                    disabled={!canAct}
                                    size="icon-sm"
                                    variant="ghost"
                                  >
                                    <MoreHorizontal />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    disabled={!canAct || !deletable}
                                    onSelect={() => setDeletion(row)}
                                    variant="destructive"
                                  >
                                    {t("delete")}
                                  </DropdownMenuItem>
                                  {!deletable && (
                                    <DropdownMenuLabel className="max-w-52 font-normal whitespace-normal text-muted-foreground">
                                      {t("deleteNeedsShutdown")}
                                    </DropdownMenuLabel>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        !refreshing && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TabletSmartphone />
              </EmptyMedia>
              <EmptyTitle>
                {t(
                  noMatchingRows
                    ? "noMatches"
                    : simulatorFamily === "ANDROID"
                      ? "androidEmptyTitle"
                      : "emptyTitle",
                )}
              </EmptyTitle>
              <EmptyDescription>
                {t(
                  noMatchingRows
                    ? "adjustFilters"
                    : simulatorFamily === "ANDROID"
                      ? "androidEmptyDescription"
                      : "emptyDescription",
                )}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      )}

      {dialog && (
        <SimulatorFleetDialog
          agents={dialog === "create" ? createAgents : resetAgents}
          inventories={inventories}
          mode={dialog}
          platform={simulatorFamily}
          onClose={() => setDialog(null)}
          onCreate={(input: CreateSimulatorInput) =>
            run([input.agentId], (signal) => createSimulator(input, signal))
          }
          onReset={(agentId) =>
            run([agentId], (signal) => resetSimulators(agentId, signal))
          }
        />
      )}
      {deletion && (
        <ConfirmationDialog
          actionLabel={t("delete")}
          cancelLabel={tc("cancel")}
          description={t("deleteDescription", {
            name: deletion.simulator.name,
            agent: deletion.agent.name,
          })}
          onConfirm={() => deleteOne(deletion)}
          onOpenChange={(open) => {
            if (!open) setDeletion(null);
          }}
          open
          title={t("deleteTitle")}
        />
      )}
      {bulkDeletion && (
        <ConfirmationDialog
          actionLabel={t("deleteSelected")}
          cancelLabel={tc("cancel")}
          description={t("deleteSelectedDescription", {
            count: bulkDeletion.size,
          })}
          onConfirm={() => deleteSelected(bulkDeletion)}
          onOpenChange={(open) => {
            if (!open) setBulkDeletion(null);
          }}
          open
          title={t("deleteSelectedTitle")}
        />
      )}
    </>
  );
}
