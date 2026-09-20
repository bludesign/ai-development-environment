"use client";

import {
  CircleDollarSign,
  ClipboardList,
  Hammer,
  ListTodo,
  MessagesSquare,
  Terminal,
  Waypoints,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useOptionalActionCenter } from "@/components/action-center/action-center-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useSidebar } from "@/components/ui/sidebar";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import {
  DISK_SPACE_FIELDS,
  monitoredVolume,
  type DiskSpaceOverview,
  type DiskSpaceStatus,
} from "./types";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";

import { diskStatusColor, formatDiskBytes, VolumeBar } from "./volume-bar";

type SidebarStatusData = {
  usageToday: { totalCost: number | null; collectedAt: string | null };
  activity: {
    plans: number;
    sessions: number;
    builds: number;
    workflows: number;
    commands: number;
  };
  diskSummary: {
    agents: Array<
      Pick<
        DiskSpaceOverview["agents"][number],
        "enabled" | "status" | "volumes"
      > & { agent: { id: string; name: string } }
    >;
  };
};

type HistoryItem = {
  id: string;
  agentName: string;
  folderName: string;
  source: "USER" | "AUTOMATIC";
  deletedAt: string;
};

const STATUS_PRIORITY: Record<DiskSpaceStatus, number> = {
  CRITICAL: 8,
  ERROR: 7,
  DELETING: 6,
  CLEANUP_REQUIRED: 5,
  PRESSURE: 4,
  STALE: 3,
  DISABLED: 2,
  IDLE: 1,
};

const ACTIVE_PRESSURE_CLASS =
  "border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20 dark:hover:text-amber-300";

function ringColor(status: DiskSpaceStatus): string {
  if (status === "CRITICAL" || status === "ERROR") return "var(--destructive)";
  if (["DELETING", "CLEANUP_REQUIRED", "PRESSURE"].includes(status))
    return "#f59e0b";
  if (status === "STALE" || status === "DISABLED")
    return "var(--muted-foreground)";
  return "#10b981";
}

export function SidebarStatusFooter() {
  const t = useTranslations("diskSpace");
  const shell = useTranslations("shell");
  const locale = useLocale();
  const actionCenter = useOptionalActionCenter();
  const { isMobile, setOpenMobile } = useSidebar();
  const [status, setStatus] = useState<SidebarStatusData | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [detail, setDetail] = useState<DiskSpaceOverview | null>(null);
  const detailUpdates = useRef<ReturnType<
    typeof createRefreshCoalescer
  > | null>(null);
  const statusUpdates = useRef<ReturnType<
    typeof createRefreshCoalescer
  > | null>(null);

  const load = useCallback(async () => {
    await statusUpdates.current?.refresh();
  }, []);

  useEffect(() => {
    const updates = createRefreshCoalescer(async (signal) => {
      try {
        const data = await controlPlaneRequest<{
          sidebarStatus: SidebarStatusData;
        }>(
          `query SidebarStatus {
          sidebarStatus {
            usageToday { totalCost collectedAt }
            activity { plans sessions builds workflows commands }
            diskSummary { agents { agent { id name } enabled status volumes { id totalBytes freeBytes roles paths status effectiveThresholdBytes monitored } } }
          }
        }`,
          undefined,
          { signal },
        );
        if (!signal.aborted) setStatus(data.sidebarStatus);
      } catch {
        /* Keep the last visible status during temporary failures. */
      }
    });
    statusUpdates.current = updates;
    const refresh = () => {
      void updates.refresh();
      void detailUpdates.current?.refresh();
    };
    const initialLoad = window.setTimeout(() => void updates.refresh(), 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      { query: "subscription SidebarStatusChanged { sidebarStatusChanged }" },
      { next: refresh, error: () => undefined, complete: () => undefined },
    );
    const offRecovery = onControlPlaneRecovery((event) => {
      // The initial mount already reads status; recovery is for a lost stream.
      if (!event?.initialConnection) refresh();
    });
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      window.clearTimeout(initialLoad);
      unsubscribe();
      offRecovery();
      window.clearInterval(timer);
      updates.dispose();
      statusUpdates.current = null;
    };
  }, []);

  useEffect(() => {
    if (!popoverOpen) return;
    const updates = createRefreshCoalescer(async (signal) => {
      try {
        const data = await controlPlaneRequest<{
          diskSpaceOverview: DiskSpaceOverview;
          derivedDataDeletionHistory: { items: HistoryItem[] };
        }>(
          `query SidebarDiskDetails {
          diskSpaceOverview { ${DISK_SPACE_FIELDS} }
          derivedDataDeletionHistory(first: 5) { items { id agentName folderName source deletedAt } }
        }`,
          undefined,
          { signal },
        );
        if (!signal.aborted) {
          setDetail(data.diskSpaceOverview);
          setHistory(data.derivedDataDeletionHistory.items);
        }
      } catch {
        /* Keep the current popover contents available while recovering. */
      }
    });
    detailUpdates.current = updates;
    void updates.refresh();
    return () => {
      detailUpdates.current = null;
      updates.dispose();
    };
  }, [popoverOpen]);

  const enabledAgents = useMemo(
    () => status?.diskSummary.agents.filter((agent) => agent.enabled) ?? [],
    [status],
  );
  const overall = useMemo(
    () =>
      [...(status?.diskSummary.agents ?? [])].sort(
        (first, second) =>
          STATUS_PRIORITY[second.status] - STATUS_PRIORITY[first.status],
      )[0]?.status ?? "STALE",
    [status],
  );

  const setPressure = async (agentId: string, enabled: boolean) => {
    setBusy(agentId);
    try {
      await controlPlaneRequest(
        `mutation SidebarPressureMode($agentId: ID!, $enabled: Boolean!) {
          setAgentDiskSpacePressureMode(agentId: $agentId, enabled: $enabled) { manualPressureMode }
        }`,
        { agentId, enabled },
      );
      await Promise.all([load(), detailUpdates.current?.refresh()]);
    } finally {
      setBusy(null);
    }
  };

  // Action Center items come from the provider that already streams them into
  // the shell; the rest are running-work counts from the sidebar status query.
  const activity = [
    {
      key: "actions",
      href: "/",
      icon: ListTodo,
      count: actionCenter?.totalCount ?? 0,
    },
    {
      key: "workflows",
      href: "/workflows",
      icon: Waypoints,
      count: status?.activity.workflows ?? 0,
    },
    {
      key: "plans",
      href: "/plans",
      icon: ClipboardList,
      count: status?.activity.plans ?? 0,
    },
    {
      key: "sessions",
      href: "/sessions",
      icon: MessagesSquare,
      count: status?.activity.sessions ?? 0,
    },
    {
      key: "builds",
      href: "/builds",
      icon: Hammer,
      count: status?.activity.builds ?? 0,
    },
    {
      key: "commands",
      href: "/commands",
      icon: Terminal,
      count: status?.activity.commands ?? 0,
    },
  ] as const;

  /**
   * The footer navigates from inside the mobile navigation sheet, which stays
   * open over the page it just moved to. The menu entries above close it on the
   * way out; every link down here does the same.
   */
  const closeMobileNavigation = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <div className="space-y-2 border-t border-sidebar-border p-2">
      <Link
        className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-sidebar-accent"
        href="/usage"
        onClick={closeMobileNavigation}
      >
        <span className="flex items-center gap-2">
          <CircleDollarSign className="size-3.5" />
          {t("usageToday")}
        </span>
        <span className="font-medium tabular-nums">
          {status?.usageToday.totalCost == null
            ? "—"
            : new Intl.NumberFormat(locale, {
                style: "currency",
                currency: "USD",
              }).format(status.usageToday.totalCost)}
        </span>
      </Link>
      <div className="grid grid-cols-2 gap-1">
        {activity.map(({ key, href, icon: Icon, count }) => (
          <Link
            className="flex items-center justify-between rounded-md px-2 py-1 text-xs hover:bg-sidebar-accent"
            href={href}
            key={key}
            onClick={closeMobileNavigation}
          >
            <span className="flex items-center gap-1.5">
              <Icon className="size-3.5" />
              {shell(key)}
            </span>
            <span className="tabular-nums">{count}</span>
          </Link>
        ))}
      </div>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            className="h-auto w-full justify-start px-2 py-2"
            variant="ghost"
          >
            <div className="min-w-0 flex-1 text-left">
              <p className="text-xs font-medium">{t("freeDiskSpace")}</p>
              {enabledAgents.length === 1 &&
              monitoredVolume(enabledAgents[0]!) ? (
                <div className="mt-1">
                  <VolumeBar
                    compact
                    hideLabel
                    volume={monitoredVolume(enabledAgents[0]!)!}
                  />
                </div>
              ) : enabledAgents.length > 1 ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {enabledAgents.map((agent) => {
                    const volume = monitoredVolume(agent);
                    if (!volume) return null;
                    const usedPercent =
                      volume.totalBytes > 0
                        ? Math.max(
                            0,
                            Math.min(
                              100,
                              ((volume.totalBytes - volume.freeBytes) /
                                volume.totalBytes) *
                                100,
                            ),
                          )
                        : 0;
                    const unfilledPercent = 100 - usedPercent;
                    return (
                      <span
                        aria-label={`${agent.agent.name} · ${t("role.DERIVED_DATA")}: ${formatDiskBytes(volume.freeBytes, locale)} ${t("free")}`}
                        className="grid size-5 place-items-center rounded-full"
                        key={agent.agent.id}
                        style={{
                          background: `conic-gradient(var(--muted) 0% ${unfilledPercent}%, ${ringColor(agent.status)} ${unfilledPercent}% 100%)`,
                        }}
                        title={`${agent.agent.name} · ${t("role.DERIVED_DATA")}`}
                      >
                        <span className="size-3 rounded-full bg-sidebar" />
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {t("noEnabledAgents")}
                </p>
              )}
            </div>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="max-h-[min(70vh,42rem)] w-[min(26rem,calc(100vw-1rem))] overflow-y-auto"
          side="top"
        >
          <PopoverHeader>
            <div className="flex items-center justify-between gap-2">
              <PopoverTitle>
                <Link
                  className="hover:underline"
                  href="/build-data"
                  onClick={closeMobileNavigation}
                >
                  {t("freeDiskSpace")}
                </Link>
              </PopoverTitle>
              <Badge
                className={
                  overall === "PRESSURE"
                    ? ACTIVE_PRESSURE_CLASS
                    : diskStatusColor(overall)
                }
                variant={overall === "PRESSURE" ? "outline" : "secondary"}
              >
                {t(`status.${overall}`)}
              </Badge>
            </div>
            {detail && (
              <p className="text-xs text-muted-foreground">
                {t("thresholdSummary", {
                  normal: detail.settings.normalThresholdGiB,
                  pressure: detail.settings.pressureThresholdGiB,
                })}
              </p>
            )}
          </PopoverHeader>
          {!detail ? (
            <Spinner />
          ) : (
            detail.agents.map((agent) => (
              <div
                className="space-y-2 rounded-md border p-2.5"
                key={agent.agent.id}
              >
                <div className="flex items-center justify-between gap-2">
                  <Link
                    className="font-medium hover:underline"
                    href={`/agents/${agent.agent.id}`}
                    onClick={closeMobileNavigation}
                  >
                    {agent.agent.name}
                  </Link>
                  <div className="flex items-center gap-1.5">
                    <Button
                      aria-pressed={agent.manualPressureMode}
                      className={
                        agent.manualPressureMode
                          ? ACTIVE_PRESSURE_CLASS
                          : undefined
                      }
                      disabled={!agent.enabled || busy !== null}
                      onClick={() =>
                        void setPressure(
                          agent.agent.id,
                          !agent.manualPressureMode,
                        )
                      }
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      {t("pressureModeControl")}
                      {busy === agent.agent.id && <Spinner />}
                    </Button>
                    <Badge
                      className={
                        agent.status === "PRESSURE"
                          ? ACTIVE_PRESSURE_CLASS
                          : undefined
                      }
                      variant="outline"
                    >
                      {t(`status.${agent.status}`)}
                    </Badge>
                  </div>
                </div>
                {agent.volumes.map((volume) => (
                  <VolumeBar compact key={volume.id} volume={volume} />
                ))}
                {(agent.lastError || agent.warnings.length > 0) && (
                  <p className="text-xs text-destructive">
                    {[agent.lastError, ...agent.warnings]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>
            ))
          )}
          <div className="space-y-1.5">
            <p className="text-xs font-medium">{t("recentDeletions")}</p>
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("noRecentDeletions")}
              </p>
            ) : (
              history.map((item) => (
                <div
                  className="grid grid-cols-[1fr_auto] gap-2 text-xs"
                  key={item.id}
                >
                  <span className="min-w-0 truncate">
                    {item.folderName} · {item.agentName}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(item.deletedAt).toLocaleDateString(locale)}
                  </span>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
