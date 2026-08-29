"use client";

import { CheckSquare2, ChevronDown, Play, Search, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { formatEnumLabel } from "@/lib/enum-label";

import type { BuildDestination, BuildRecord, BuildRunAgent } from "./types";

export function RunBuildControls({
  buildId,
  destinationType,
  preferredDestination,
  onCompleted,
  onError,
  size = "default",
  compact = false,
}: {
  buildId: string;
  destinationType: BuildRecord["destinationType"];
  preferredDestination?: BuildDestination | null;
  onCompleted?: () => void | Promise<void>;
  onError: (error: string | null) => void;
  size?: "xs" | "sm" | "default";
  compact?: boolean;
}) {
  const t = useTranslations("builds");
  const preferred = preferredDestination?.generic
    ? null
    : (preferredDestination ?? null);
  const [destinations, setDestinations] = useState<BuildDestination[]>(
    preferred ? [preferred] : [],
  );
  const [selectedDestinations, setSelectedDestinations] = useState<Set<string>>(
    preferred ? new Set([preferred.id]) : new Set(),
  );
  const [destinationsLoaded, setDestinationsLoaded] = useState(false);
  const [loadingDestinations, setLoadingDestinations] = useState(false);
  const [runAgents, setRunAgents] = useState<BuildRunAgent[]>([]);
  const [runAgentsLoaded, setRunAgentsLoaded] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const activeAgentId = useRef<string | null>(null);
  const loadingAgentId = useRef<string | null>(null);
  const agentTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const destinationCache = useRef(new Map<string, BuildDestination[]>());
  const [destinationSearch, setDestinationSearch] = useState("");
  const [running, setRunning] = useState(false);
  const [runningDestinationId, setRunningDestinationId] = useState<
    string | null
  >(null);

  const selectedNames = useMemo(
    () =>
      destinations
        .filter((destination) => selectedDestinations.has(destination.id))
        .map((destination) => destination.name),
    [destinations, selectedDestinations],
  );
  const filteredDestinations = useMemo(() => {
    const query = destinationSearch.trim().toLocaleLowerCase();
    if (!query) return destinations;

    return destinations.filter((destination) => {
      const state = destination.state
        ? formatEnumLabel(destination.state)
        : destination.available === false
          ? t("unavailable")
          : t("available");
      return [
        destination.name,
        destination.platform,
        destination.osVersion,
        destination.state,
        state,
      ].some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [destinationSearch, destinations, t]);
  const tabStopAgentId =
    runAgents.find(
      (option) => option.agent.id === selectedAgentId && option.available,
    )?.agent.id ?? runAgents.find((option) => option.available)?.agent.id;

  const applyDestinations = (compatible: BuildDestination[]) => {
    setDestinations(compatible);
    setSelectedDestinations((current) => {
      const availableIds = new Set(
        compatible
          .filter((destination) => destination.available !== false)
          .map((destination) => destination.id),
      );
      return new Set([...current].filter((id) => availableIds.has(id)));
    });
    setDestinationsLoaded(true);
  };

  const loadDestinations = async (agentId: string) => {
    const cached = destinationCache.current.get(agentId);
    if (cached) {
      if (activeAgentId.current === agentId) applyDestinations(cached);
      return;
    }
    loadingAgentId.current = agentId;
    setLoadingDestinations(true);
    onError(null);
    try {
      const data = await controlPlaneRequest<{
        inspectBuildRunDestinations: BuildDestination[];
      }>(
        `mutation BuildRunDestinations($buildId: ID!, $agentId: ID, $requestId: ID!) {
          inspectBuildRunDestinations(buildId: $buildId, agentId: $agentId, requestId: $requestId)
        }`,
        { buildId, agentId, requestId: createClientId() },
      );
      const compatible = data.inspectBuildRunDestinations.filter(
        (destination) =>
          destination.type === destinationType && !destination.generic,
      );
      destinationCache.current.set(agentId, compatible);
      if (activeAgentId.current === agentId) applyDestinations(compatible);
    } catch (value) {
      if (activeAgentId.current === agentId) {
        onError(value instanceof Error ? value.message : String(value));
      }
    } finally {
      if (loadingAgentId.current === agentId) {
        loadingAgentId.current = null;
        setLoadingDestinations(false);
      }
    }
  };

  const loadRunAgents = async () => {
    onError(null);
    setLoadingDestinations(true);
    try {
      const data = await controlPlaneRequest<{
        buildRunAgents: BuildRunAgent[];
      }>(
        `query BuildRunAgents($buildId: ID!) {
          buildRunAgents(buildId: $buildId) {
            isBuildAgent available unavailableReason
            agent { id name hostname osVersion architecture connectionStatus }
          }
        }`,
        { buildId },
      );
      setRunAgents(data.buildRunAgents);
      setRunAgentsLoaded(true);
      const selected =
        data.buildRunAgents.find((option) => option.isBuildAgent) ??
        data.buildRunAgents.find((option) => option.available);
      if (!selected) {
        activeAgentId.current = null;
        setDestinations([]);
        setDestinationsLoaded(true);
        return;
      }
      activeAgentId.current = selected.agent.id;
      setSelectedAgentId(selected.agent.id);
      if (selected.available) await loadDestinations(selected.agent.id);
      else {
        setDestinations([]);
        setDestinationsLoaded(true);
      }
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      if (!loadingAgentId.current) setLoadingDestinations(false);
    }
  };

  const selectAgent = (option: BuildRunAgent) => {
    if (!option.available || option.agent.id === selectedAgentId) return;
    activeAgentId.current = option.agent.id;
    setSelectedAgentId(option.agent.id);
    setSelectedDestinations(new Set());
    setDestinations([]);
    setDestinationsLoaded(false);
    setDestinationSearch("");
    void loadDestinations(option.agent.id);
  };

  const selectAdjacentAgent = (currentAgentId: string, direction: -1 | 1) => {
    const available = runAgents.filter((option) => option.available);
    const currentIndex = available.findIndex(
      (option) => option.agent.id === currentAgentId,
    );
    if (currentIndex < 0 || available.length < 2) return;
    const next =
      available[
        (currentIndex + direction + available.length) % available.length
      ];
    if (!next) return;
    selectAgent(next);
    agentTabRefs.current.get(next.agent.id)?.focus();
  };

  const run = async (onlyDestination?: BuildDestination) => {
    setRunning(true);
    setRunningDestinationId(onlyDestination?.id ?? null);
    onError(null);
    try {
      await controlPlaneRequest(
        `mutation RunCompletedBuild($input: RunBuildInput!) {
          runBuild(input: $input) { id status }
        }`,
        {
          input: {
            buildId,
            targetAgentId: selectedAgentId,
            destinations: onlyDestination
              ? [onlyDestination]
              : destinations.filter(
                  (destination) =>
                    destination.available !== false &&
                    selectedDestinations.has(destination.id),
                ),
            requestId: createClientId(),
          },
        },
      );
      if (!onlyDestination) setSelectedDestinations(new Set());
      await onCompleted?.();
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      setRunning(false);
      setRunningDestinationId(null);
    }
  };

  const toggleDestination = (destination: BuildDestination) => {
    if (destination.available === false) return;
    setSelectedDestinations((current) => {
      const next = new Set(current);
      if (next.has(destination.id)) next.delete(destination.id);
      else next.add(destination.id);
      return next;
    });
  };

  const handleMenuOpenChange = (open: boolean) => {
    if (open && !runAgentsLoaded) void loadRunAgents();
    else if (open && selectedAgentId && !destinationsLoaded) {
      void loadDestinations(selectedAgentId);
    }
    if (!open) setDestinationSearch("");
  };

  const destinationMenu = (
    <DropdownMenuContent align="end" className="w-80">
      <div
        aria-label={t("runAgents")}
        className="flex gap-1 overflow-x-auto p-1.5"
        role="tablist"
      >
        {runAgents.map((option) => {
          const reason = option.unavailableReason
            ? t(`runAgentUnavailable.${option.unavailableReason}`)
            : null;
          return (
            <Button
              aria-label={
                reason ? `${option.agent.name}: ${reason}` : option.agent.name
              }
              aria-selected={option.agent.id === selectedAgentId}
              className="h-auto shrink-0 flex-col items-start gap-0 px-2 py-1"
              disabled={!option.available || running}
              key={option.agent.id}
              onClick={() => selectAgent(option)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                selectAdjacentAgent(
                  option.agent.id,
                  event.key === "ArrowLeft" ? -1 : 1,
                );
              }}
              ref={(element) => {
                if (element) agentTabRefs.current.set(option.agent.id, element);
                else agentTabRefs.current.delete(option.agent.id);
              }}
              role="tab"
              size="sm"
              tabIndex={option.agent.id === tabStopAgentId ? 0 : -1}
              title={
                reason ??
                `${option.agent.osVersion} · ${option.agent.architecture}`
              }
              type="button"
              variant={
                option.agent.id === selectedAgentId ? "secondary" : "ghost"
              }
            >
              <span>{option.agent.name}</span>
              <span className="text-[10px] font-normal text-muted-foreground">
                {option.isBuildAgent
                  ? t("buildAgent")
                  : (reason ?? option.agent.hostname)}
              </span>
            </Button>
          );
        })}
      </div>
      <DropdownMenuSeparator />
      <div className="relative p-1.5">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label={t("searchDevices")}
          className="h-7 pl-7 text-xs"
          onChange={(event) => setDestinationSearch(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          placeholder={t("searchDevices")}
          type="search"
          value={destinationSearch}
        />
      </div>
      <DropdownMenuSeparator />
      {loadingDestinations && (
        <div className="flex justify-center p-3 text-muted-foreground">
          <Spinner />
        </div>
      )}
      <div className="max-h-72 overflow-y-auto">
        {!loadingDestinations &&
          filteredDestinations.map((destination) => {
            const available = destination.available !== false;
            const selected = selectedDestinations.has(destination.id);
            const detail = [destination.platform, destination.osVersion]
              .filter(Boolean)
              .join(" ");
            const state = destination.state
              ? formatEnumLabel(destination.state)
              : available
                ? t("available")
                : t("unavailable");
            return (
              <div
                className="flex items-stretch gap-1 rounded-md p-0.5 hover:bg-accent"
                key={`${destination.type}:${destination.id}`}
              >
                <button
                  aria-checked={selected}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!available || running}
                  onClick={() => toggleDestination(destination)}
                  role="menuitemcheckbox"
                  type="button"
                >
                  {selected ? (
                    <CheckSquare2 className="size-4 shrink-0" />
                  ) : (
                    <Square className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {destination.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {detail ? `${detail} · ${state}` : state}
                    </span>
                  </span>
                </button>
                <Button
                  aria-label={t("runOnDevice", { name: destination.name })}
                  disabled={!available || running}
                  onClick={() => void run(destination)}
                  size="icon-sm"
                  title={t("runOnDevice", { name: destination.name })}
                  type="button"
                  variant="ghost"
                >
                  {runningDestinationId === destination.id ? (
                    <Spinner />
                  ) : (
                    <Play />
                  )}
                </Button>
              </div>
            );
          })}
      </div>
      {destinationsLoaded && !destinations.length && (
        <p className="p-2 text-xs text-muted-foreground">
          {t("noCompatibleDevices")}
        </p>
      )}
      {destinationsLoaded &&
        destinations.length > 0 &&
        filteredDestinations.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">
            {t("noDevicesMatchSearch")}
          </p>
        )}
      <DropdownMenuSeparator />
      <div className="flex items-center justify-between gap-2 px-1 py-0.5">
        <div className="flex gap-1">
          <Button
            disabled={
              running || !destinations.some((item) => item.available !== false)
            }
            onClick={() =>
              setSelectedDestinations(
                new Set(
                  destinations
                    .filter((destination) => destination.available !== false)
                    .map((destination) => destination.id),
                ),
              )
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("selectAllDevices")}
          </Button>
          <Button
            disabled={running || selectedDestinations.size === 0}
            onClick={() => setSelectedDestinations(new Set())}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("clearDevices")}
          </Button>
        </div>
        {compact && (
          <Button
            disabled={running || selectedDestinations.size === 0}
            onClick={() => void run()}
            size="sm"
            type="button"
          >
            {running && runningDestinationId === null ? <Spinner /> : <Play />}
            {t("runSelected")}
          </Button>
        )}
      </div>
    </DropdownMenuContent>
  );

  if (compact) {
    return (
      <div
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DropdownMenu onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button disabled={running} size={size} type="button">
              {loadingDestinations || running ? <Spinner /> : <Play />}
              {t("run")}
            </Button>
          </DropdownMenuTrigger>
          {destinationMenu}
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-end gap-2"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenu onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            disabled={loadingDestinations}
            size={size}
            type="button"
            variant="outline"
          >
            {loadingDestinations ? <Spinner /> : <Play />}
            {selectedNames.length
              ? t("selectedDevices", { count: selectedNames.length })
              : t("selectRunDevices")}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        {destinationMenu}
      </DropdownMenu>
      <Button
        disabled={running || selectedDestinations.size === 0}
        onClick={() => void run()}
        size={size}
        type="button"
      >
        {running ? <Spinner /> : <Play />} {t("run")}
      </Button>
    </div>
  );
}
