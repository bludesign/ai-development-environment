"use client";

import {
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  TabletSmartphone,
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
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
} from "./simulator-client";
import { SimulatorStateBadge } from "./simulator-state-badge";

type SimulatorRow = {
  agent: ActiveAgentOption;
  simulator: Simulator;
  deviceTypeName: string | undefined;
};

export function SimulatorsPage() {
  const t = useTranslations("simulators");
  const { activeAgentId, agents, loading, ready, error } = useActiveAgent();
  const [selection, setSelection] = usePageAgentFilter(
    "simulators",
    ALL_PAGE_AGENTS,
  );
  const agentId =
    activeAgentId ?? (selection === ALL_PAGE_AGENTS ? null : selection);

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
        <PageAgentFilter value={selection} onValueChange={setSelection} />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {ready && (!loading || agents.length > 0) ? (
        <SimulatorList
          key={agentId ?? ALL_PAGE_AGENTS}
          agents={
            agentId ? agents.filter((agent) => agent.id === agentId) : agents
          }
        />
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      )}
    </section>
  );
}

function SimulatorList({ agents }: { agents: ActiveAgentOption[] }) {
  const t = useTranslations("simulators");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [inventories, setInventories] = useState<
    Record<string, SimulatorInventory>
  >({});
  const [agentErrors, setAgentErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [refreshing, setRefreshing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("all");
  const [state, setState] = useState("all");
  const [dialog, setDialog] = useState<"create" | "reset" | null>(null);
  const [deletion, setDeletion] = useState<SimulatorRow | null>(null);
  const inventoryRequest = useRef<AbortController | null>(null);
  const operationRequest = useRef<AbortController | null>(null);

  const eligibleIds = agents
    .filter((agent) => simulatorAgentSupports(agent, "inventory"))
    .map(({ id }) => id)
    .join("\0");
  const refresh = useCallback(
    async (onlyAgentId?: string) => {
      inventoryRequest.current?.abort();
      const controller = new AbortController();
      inventoryRequest.current = controller;
      const agentIds = eligibleIds ? eligibleIds.split("\0") : [];
      const targets = onlyAgentId
        ? agentIds.filter((id) => id === onlyAgentId)
        : agentIds;
      setRefreshing(targets.length > 0);
      await Promise.all(
        targets.map(async (id) => {
          try {
            const result = await refreshSimulatorInventory(
              id,
              controller.signal,
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
          }
        }),
      );
      if (!controller.signal.aborted) setRefreshing(false);
    },
    [eligibleIds],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timer);
      inventoryRequest.current?.abort();
    };
  }, [refresh]);

  useEffect(() => () => operationRequest.current?.abort(), []);

  async function run(
    agentId: string,
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
        await refresh(agentId);
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  const runRowAction = async (
    { agent, simulator }: SimulatorRow,
    action: SimulatorAction,
  ) => {
    try {
      await run(agent.id, (signal) =>
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
    (agent) => simulatorAgentSupports(agent, "create") && inventories[agent.id],
  );
  const resetAgents = agents.filter((agent) =>
    simulatorAgentSupports(agent, "reset"),
  );
  const noMatchingRows = rows.length > 0 && filtered.length === 0;
  const groups = agents
    .map((agent) => ({
      agent,
      rows: filtered.filter((row) => row.agent.id === agent.id),
    }))
    .filter((group) => group.rows.length > 0);

  return (
    <>
      <div className="flex flex-wrap items-start gap-2">
        <div className="relative w-full sm:mr-auto sm:w-auto sm:min-w-56 sm:flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label={t("search")}
            className="pl-9"
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("search")}
            value={search}
          />
        </div>
        <Select onValueChange={setPlatform} value={platform}>
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
        <Select onValueChange={setState} value={state}>
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
          disabled={refreshing || busy || !eligibleIds}
          onClick={() => void refresh()}
          variant="outline"
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />{" "}
          {t("refresh")}
        </Button>
        <Button
          disabled={busy || refreshing || !resetAgents.length}
          onClick={() => setDialog("reset")}
          variant="outline"
        >
          {t("reset")}
        </Button>
        <Button
          disabled={busy || refreshing || !createAgents.length}
          onClick={() => setDialog("create")}
        >
          <Plus /> {t("create")}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {agents.map((agent) => {
        const message =
          agent.connectionStatus !== "ONLINE"
            ? t("offline")
            : !simulatorAgentSupports(agent, "inventory")
              ? t("agentUpdateRequired")
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
                <TableHead>{t("name")}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t("runtime")}
                </TableHead>
                <TableHead>{t("state")}</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">{t("actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map(({ agent, rows }) => (
                <Fragment key={agent.id}>
                  <TableRow className="bg-muted/35 hover:bg-muted/35">
                    <TableCell className="px-3 py-1.5 font-medium" colSpan={4}>
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
                    const canAct =
                      !busy &&
                      !refreshing &&
                      !agentErrors[agent.id] &&
                      simulatorAgentSupports(agent, "action");
                    const booted = simulator.state.toLowerCase() === "booted";
                    const shutDown =
                      simulator.state.toLowerCase() === "shutdown";
                    return (
                      <TableRow key={`${agent.id}:${simulator.id}`}>
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
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {simulator.isAvailable && (booted || shutDown) && (
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
                                  disabled={!shutDown}
                                  onSelect={() => setDeletion(row)}
                                  variant="destructive"
                                >
                                  {t("delete")}
                                </DropdownMenuItem>
                                {!shutDown && (
                                  <DropdownMenuLabel className="max-w-52 font-normal whitespace-normal text-muted-foreground">
                                    {t("deleteNeedsShutdown")}
                                  </DropdownMenuLabel>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
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
                {t(noMatchingRows ? "noMatches" : "emptyTitle")}
              </EmptyTitle>
              <EmptyDescription>
                {t(noMatchingRows ? "adjustFilters" : "emptyDescription")}
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
          onClose={() => setDialog(null)}
          onCreate={(input: CreateSimulatorInput) =>
            run(input.agentId, (signal) => createSimulator(input, signal))
          }
          onReset={(agentId) =>
            run(agentId, (signal) => resetSimulators(agentId, signal))
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
          onConfirm={() => runRowAction(deletion, "DELETE")}
          onOpenChange={(open) => {
            if (!open) setDeletion(null);
          }}
          open
          title={t("deleteTitle")}
        />
      )}
    </>
  );
}
