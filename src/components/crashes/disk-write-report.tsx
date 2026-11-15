"use client";

import { ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { DetailItem, DetailList } from "@/components/common/detail-list";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { FramesTable } from "./frames-table";
import type {
  DiskWriteDetails,
  DiskWriteSummary,
  SampledFrame,
  SampledNode,
} from "./types";

function useDiskWriteFormatting() {
  const locale = useLocale();
  const t = useTranslations("crashes.diskWrites");

  function bytes(value: number, rate = false) {
    const unit =
      !rate && value >= 1e6 ? "megabyte" : value >= 1e3 ? "kilobyte" : "byte";
    const divisor = unit === "megabyte" ? 1e6 : unit === "kilobyte" ? 1e3 : 1;
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      maximumFractionDigits: 2,
    }).format(value / divisor);
  }

  function duration(value: number) {
    const rounded = Math.round(value);
    const format = (amount: number, unit: string) =>
      new Intl.NumberFormat(locale, { style: "unit", unit }).format(amount);
    if (rounded >= 3600 && rounded % 3600 === 0) {
      return format(rounded / 3600, "hour");
    }
    const minutes = Math.floor(rounded / 60);
    const seconds = rounded % 60;
    return [
      minutes ? format(minutes, "minute") : null,
      seconds || !minutes ? format(seconds, "second") : null,
    ]
      .filter(Boolean)
      .join(" ");
  }

  function action(value: string) {
    return value.toLowerCase() === "none" ? t("noAction") : value;
  }

  return { bytes, duration, action };
}

export function DiskWriteSummaryLine({ disk }: { disk: DiskWriteSummary }) {
  const t = useTranslations("crashes.diskWrites");
  const { bytes, duration, action } = useDiskWriteFormatting();
  const writes = bytes(disk.writesBytes);
  return [
    disk.durationSeconds === null
      ? writes
      : t("writesIn", { writes, duration: duration(disk.durationSeconds) }),
    disk.action ? action(disk.action) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function DiskWriteOverview({ disk }: { disk: DiskWriteDetails }) {
  const t = useTranslations("crashes.diskWrites");
  const { bytes, duration, action } = useDiskWriteFormatting();
  const limit = disk.limitBytes === null ? null : bytes(disk.limitBytes);
  return (
    <>
      <DetailList className="sm:grid-cols-2 lg:grid-cols-4">
        <DetailItem label={t("writesCaused")}>
          {bytes(disk.writesBytes)}
        </DetailItem>
        <DetailItem label={t("writeLimit")}>
          {limit && disk.limitDurationSeconds !== null
            ? t("limitOver", {
                limit,
                duration: duration(disk.limitDurationSeconds),
              })
            : (limit ?? "—")}
        </DetailItem>
        <DetailItem label={t("averageRate")}>
          {disk.averageBytesPerSecond === null
            ? "—"
            : t("perSecond", {
                writes: bytes(disk.averageBytesPerSecond, true),
              })}
        </DetailItem>
        <DetailItem label={t("action")}>
          {disk.action ? action(disk.action) : "—"}
        </DetailItem>
        <DetailItem label={t("startedAt")}>
          <DateTime value={disk.startedAt} />
        </DetailItem>
        <DetailItem label={t("endedAt")}>
          <DateTime value={disk.endedAt} />
        </DetailItem>
        <DetailItem label={t("duration")}>
          {disk.durationSeconds === null ? "—" : duration(disk.durationSeconds)}
        </DetailItem>
        <DetailItem label={t("sampledDuration")}>
          {disk.sampledDurationSeconds === null
            ? "—"
            : duration(disk.sampledDurationSeconds)}
        </DetailItem>
        <DetailItem label={t("samplesCaptured")}>
          {disk.samplesCaptured ?? "—"}
        </DetailItem>
        <DetailItem label={t("samplesLost")}>
          {disk.samplesLost ?? "—"}
        </DetailItem>
      </DetailList>
      <p className="mt-3 text-sm text-muted-foreground">{t("samplingNote")}</p>
    </>
  );
}

export function HeaviestStack({
  entries,
  showSampleLabel = true,
}: {
  entries: SampledFrame[];
  showSampleLabel?: boolean;
}) {
  const t = useTranslations("crashes.diskWrites");
  const frames = entries.flatMap((entry, index) =>
    entry.frames.map((frame) => ({ ...frame, index })),
  );
  return (
    <>
      {showSampleLabel && frames.length > 0 ? (
        <p className="border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
          {t("samples")}
        </p>
      ) : null}
      <FramesTable
        frames={frames}
        sampleCounts={entries.map((entry) => entry.sampleCount)}
      />
    </>
  );
}

export function SampledCallTree({ nodes }: { nodes: SampledNode[] }) {
  const t = useTranslations("crashes.diskWrites");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const children = useMemo(() => {
    const tree = new Map<number | null, SampledNode[]>();
    for (const node of nodes) {
      const entries = tree.get(node.parentId) ?? [];
      entries.push(node);
      tree.set(node.parentId, entries);
    }
    return tree;
  }, [nodes]);

  if (!nodes.length) return <FramesTable frames={[]} />;

  const visible: { node: SampledNode; depth: number }[] = [];
  const pending = (children.get(null) ?? [])
    .map((node) => ({ node, depth: 0 }))
    .reverse();
  while (pending.length) {
    const entry = pending.pop()!;
    visible.push(entry);
    if (!expanded.has(entry.node.id)) continue;
    const branch = children.get(entry.node.id) ?? [];
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      pending.push({ node: branch[index]!, depth: entry.depth + 1 });
    }
  }

  return (
    <div className="rounded-lg border">
      <p className="border-b bg-muted/40 px-4 py-1.5 pl-10 text-xs text-muted-foreground">
        {t("samples")}
      </p>
      <ul className="divide-y">
        {visible.map(({ node, depth }) => {
          const open = expanded.has(node.id);
          return (
            <li
              key={node.id}
              className="flex min-w-0 items-start"
              style={{ paddingInlineStart: Math.min(depth, 12) * 10 }}
            >
              {children.has(node.id) ? (
                <Button
                  aria-expanded={open}
                  aria-label={t(open ? "collapseBranch" : "expandBranch", {
                    frame:
                      node.frames[0]?.symbol ??
                      node.frames[0]?.imageName ??
                      "?",
                  })}
                  className="mt-0.5 size-6 shrink-0"
                  onClick={() =>
                    setExpanded((previous) => {
                      const next = new Set(previous);
                      if (next.has(node.id)) next.delete(node.id);
                      else next.add(node.id);
                      return next;
                    })
                  }
                  size="icon"
                  variant="ghost"
                >
                  <ChevronRight
                    className={cn(
                      "size-4 transition-transform",
                      open && "rotate-90",
                    )}
                  />
                </Button>
              ) : (
                <span aria-hidden className="size-6 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <HeaviestStack entries={[node]} showSampleLabel={false} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
