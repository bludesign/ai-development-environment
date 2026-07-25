"use client";

import {
  CircleDollarSign,
  ClipboardList,
  Hammer,
  HardDrive,
  MessagesSquare,
  Waypoints,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import {
  DISK_SPACE_FIELDS,
  mostConstrainedVolume,
  type DiskSpaceOverview,
  type DiskSpaceStatus,
} from "./types";
import { diskStatusColor, formatDiskBytes, VolumeBar } from "./volume-bar";

type SidebarStatusData = {
  usageToday: { totalCost: number | null; collectedAt: string | null };
  activity: {
    plans: number;
    sessions: number;
    builds: number;
    workflows: number;
  };
  diskSpace: DiskSpaceOverview;
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
  const [status, setStatus] = useState<SidebarStatusData | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        sidebarStatus: SidebarStatusData;
        derivedDataDeletionHistory: { items: HistoryItem[] };
      }>(`query SidebarStatus {
        sidebarStatus {
          usageToday { totalCost collectedAt }
          activity { plans sessions builds workflows }
          diskSpace { ${DISK_SPACE_FIELDS} }
        }
        derivedDataDeletionHistory(first: 5) {
          items { id agentName folderName source deletedAt }
        }
      }`);
      setStatus(data.sidebarStatus);
      setHistory(data.derivedDataDeletionHistory.items);
    } catch {
      // The footer stays unobtrusive when the control plane is unavailable.
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      sidebarStatusChanged: boolean;
    }>(
      { query: "subscription SidebarStatusChanged { sidebarStatusChanged }" },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      window.clearTimeout(initialLoad);
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [load]);

  const enabledAgents = useMemo(
    () => status?.diskSpace.agents.filter((agent) => agent.enabled) ?? [],
    [status],
  );
  const overall = useMemo(
    () =>
      [...(status?.diskSpace.agents ?? [])].sort(
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
      await load();
    } finally {
      setBusy(null);
    }
  };

  const activity = [
    { key: "plans", href: "/plans", icon: ClipboardList },
    { key: "sessions", href: "/sessions", icon: MessagesSquare },
    { key: "builds", href: "/builds", icon: Hammer },
    { key: "workflows", href: "/workflows", icon: Waypoints },
  ] as const;

  return (
    <div className="space-y-2 border-t border-sidebar-border p-2">
      <Link
        className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-sidebar-accent"
        href="/usage"
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
        {activity.map(({ key, href, icon: Icon }) => (
          <Link
            className="flex items-center justify-between rounded-md px-2 py-1 text-xs hover:bg-sidebar-accent"
            href={href}
            key={key}
          >
            <span className="flex items-center gap-1.5">
              <Icon className="size-3.5" />
              {shell(key)}
            </span>
            <span className="tabular-nums">{status?.activity[key] ?? 0}</span>
          </Link>
        ))}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            className="h-auto w-full justify-start px-2 py-2"
            variant="ghost"
          >
            <HardDrive className="size-4" />
            <div className="min-w-0 flex-1 text-left">
              <p className="text-xs font-medium">{t("freeDiskSpace")}</p>
              {enabledAgents.length === 1 &&
              mostConstrainedVolume(enabledAgents[0]!) ? (
                <div className="mt-1">
                  <VolumeBar
                    compact
                    volume={mostConstrainedVolume(enabledAgents[0]!)!}
                  />
                </div>
              ) : enabledAgents.length > 1 ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {enabledAgents.map((agent) => {
                    const volume = mostConstrainedVolume(agent);
                    if (!volume) return null;
                    const freePercent =
                      volume.totalBytes > 0
                        ? Math.max(
                            0,
                            Math.min(
                              100,
                              (volume.freeBytes / volume.totalBytes) * 100,
                            ),
                          )
                        : 0;
                    return (
                      <span
                        aria-label={`${agent.agent.name}: ${formatDiskBytes(volume.freeBytes, locale)} ${t("free")}`}
                        className="grid size-5 place-items-center rounded-full"
                        key={agent.agent.id}
                        style={{
                          background: `conic-gradient(${ringColor(agent.status)} ${freePercent}%, var(--muted) ${freePercent}% 100%)`,
                        }}
                        title={agent.agent.name}
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
              <PopoverTitle>{t("freeDiskSpace")}</PopoverTitle>
              <Badge variant="secondary" className={diskStatusColor(overall)}>
                {t(`status.${overall}`)}
              </Badge>
            </div>
            {status && (
              <p className="text-xs text-muted-foreground">
                {t("thresholdSummary", {
                  normal: status.diskSpace.settings.normalThresholdGiB,
                  pressure: status.diskSpace.settings.pressureThresholdGiB,
                })}
              </p>
            )}
          </PopoverHeader>
          <Separator />
          {!status ? (
            <Spinner />
          ) : (
            status.diskSpace.agents.map((agent) => (
              <div
                className="space-y-2 rounded-md border p-2.5"
                key={agent.agent.id}
              >
                <div className="flex items-center justify-between gap-2">
                  <Link
                    className="font-medium hover:underline"
                    href={`/agents/${agent.agent.id}`}
                  >
                    {agent.agent.name}
                  </Link>
                  <Badge variant="outline">{t(`status.${agent.status}`)}</Badge>
                </div>
                <Label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={agent.manualPressureMode}
                    disabled={!agent.enabled || busy !== null}
                    onCheckedChange={(checked) =>
                      void setPressure(agent.agent.id, checked === true)
                    }
                  />
                  {t("pressureModeControl")}
                  {busy === agent.agent.id && <Spinner />}
                </Label>
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
          <Separator />
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
