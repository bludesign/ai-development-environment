"use client";

import { useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type { DiskSpaceStatus, DiskSpaceVolume } from "./types";

export function formatDiskBytes(value: number, locale: string): string {
  const gib = value / 1024 ** 3;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(gib)} GiB`;
}

export function diskStatusColor(status: DiskSpaceStatus): string {
  if (status === "CRITICAL" || status === "ERROR") return "bg-destructive";
  if (
    status === "PRESSURE" ||
    status === "CLEANUP_REQUIRED" ||
    status === "DELETING"
  )
    return "bg-amber-500";
  if (status === "DISABLED" || status === "STALE") return "bg-muted-foreground";
  return "bg-emerald-500";
}

export function VolumeBar({
  volume,
  compact = false,
}: {
  volume: DiskSpaceVolume;
  compact?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("diskSpace");
  const usedPercent =
    volume.totalBytes > 0
      ? Math.max(
          0,
          Math.min(
            100,
            ((volume.totalBytes - volume.freeBytes) / volume.totalBytes) * 100,
          ),
        )
      : 0;
  const roleLabel = volume.roles.map((role) => t(`role.${role}`)).join(", ");
  return (
    <div className={cn("space-y-1.5", compact && "space-y-1")}>
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
        <span className="truncate font-medium">{roleLabel || t("volume")}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatDiskBytes(volume.freeBytes, locale)} {t("freeOf")}{" "}
          {formatDiskBytes(volume.totalBytes, locale)}
        </span>
      </div>
      <div
        aria-label={t("usageLabel", { percent: Math.round(usedPercent) })}
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(usedPercent)}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            diskStatusColor(volume.status),
          )}
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      {!compact && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{t(`status.${volume.status}`)}</Badge>
          {volume.paths.map((path) => (
            <span
              className="break-all font-mono text-[11px] text-muted-foreground"
              key={path}
            >
              {path}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
