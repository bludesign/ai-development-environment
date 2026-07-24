"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, Code2, Copy } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { copyText } from "@/lib/browser-utils";
import { cn } from "@/lib/utils";

import {
  describeActivity,
  groupActivity,
  itemGroupTitle,
  type ActivityDetailRow,
} from "./activity";
import { MarkdownView } from "./markdown-view";
import { useRunLabels } from "./run-labels";
import type { RunEventView } from "./types";

/**
 * The expanded panel spans every column of a `table-fixed` table, so it may
 * never be wider than the collapsed row. `TableCell` defaults to
 * `whitespace-nowrap` for the summary rows, which would otherwise cascade into
 * the detail and push the feed into a horizontal scroll; detail content wraps
 * instead, and anything genuinely unwrappable scrolls inside its own box.
 */
const DETAIL_CELL_CLASS =
  "bg-muted/10 px-4 py-3 align-top break-words whitespace-normal";

function toggleKey(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * A monospaced dump of the untouched payload with a one-click copy. `action`
 * shares the toolbar row so the rendered/raw toggle sits beside the copy button
 * instead of stacking above it.
 */
function RawJson({ value, action }: { value: unknown; action?: ReactNode }) {
  const t = useTranslations("runs");
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(value, null, 2);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {action}
        <Button
          onClick={() =>
            void copyText(json).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            })
          }
          size="xs"
          type="button"
          variant="outline"
        >
          {copied ? <Check /> : <Copy />} {copied ? t("copied") : t("copy")}
        </Button>
      </div>
      <pre className="max-h-96 overflow-auto rounded bg-muted p-3 text-xs break-words whitespace-pre-wrap">
        {json}
      </pre>
    </div>
  );
}

function DetailRows({ rows }: { rows: ActivityDetailRow[] }) {
  // `table-fixed` keeps the nested table inside the width the outer activity
  // table allocates: an auto-layout table refuses to shrink below its widest
  // cell's content, which is what pushed the whole feed sideways.
  if (rows.length >= 3)
    return (
      <div className="overflow-hidden rounded-md border">
        <table className="w-full table-fixed text-xs">
          <tbody className="divide-y">
            {rows.map((row, index) => (
              <tr className="align-top" key={`${row.label}:${index}`}>
                <th className="w-40 bg-muted/30 px-3 py-2 text-left font-medium break-words text-muted-foreground">
                  {row.label}
                </th>
                <td className="min-w-0 px-3 py-2 break-words whitespace-pre-wrap">
                  {row.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 text-xs">
      {rows.map((row, index) => (
        <Fragment key={`${row.label}:${index}`}>
          <dt className="break-words text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words whitespace-pre-wrap">
            {row.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * The body of an expanded row. Parsed detail leads, with the raw payload behind
 * a toggle; an event with nothing parsed shows the raw payload outright, and one
 * with no payload at all says so rather than leaving an empty panel.
 */
function ActivityDetail({
  event,
  showRaw,
  onToggleRaw,
}: {
  event: RunEventView;
  showRaw: boolean;
  onToggleRaw: () => void;
}) {
  const t = useTranslations("runs");
  const locale = useLocale();
  const descriptor = describeActivity(event, locale);
  const rows = descriptor.detailRows;
  const markdown = event.detailMarkdown?.trim() ? event.detailMarkdown : null;
  const hasRendered = rows.length > 0 || Boolean(markdown);
  const hasRaw = event.raw !== null && event.raw !== undefined;

  if (!hasRendered && !hasRaw)
    return <p className="text-xs text-muted-foreground">{t("noDetail")}</p>;
  if (!hasRendered) return <RawJson value={event.raw} />;

  const rawToggle = hasRaw ? (
    <Button onClick={onToggleRaw} size="xs" type="button" variant="outline">
      <Code2 /> {showRaw ? t("rendered") : t("raw")}
    </Button>
  ) : null;

  return (
    <div className="space-y-2">
      {showRaw && hasRaw ? (
        <RawJson action={rawToggle} value={event.raw} />
      ) : (
        <>
          {rawToggle}
          <div className="space-y-3">
            {rows.length > 0 && <DetailRows rows={rows} />}
            {markdown && <MarkdownView showActions={false} value={markdown} />}
          </div>
        </>
      )}
    </div>
  );
}

function ActivityRow({
  event,
  title,
  line,
  indent = false,
  expanded,
  onToggle,
  showRaw,
  onToggleRaw,
}: {
  event: RunEventView;
  title: string;
  line: string;
  indent?: boolean;
  expanded: boolean;
  onToggle: () => void;
  showRaw: boolean;
  onToggleRaw: () => void;
}) {
  const locale = useLocale();
  const Icon = describeActivity(event, locale).icon;
  return (
    <>
      <TableRow
        aria-expanded={expanded}
        className={cn("cursor-pointer", event.supersededAt && "opacity-60")}
        onClick={onToggle}
      >
        <TableCell className="h-8 py-1">
          <span className={cn("flex items-center gap-1", indent && "pl-5")}>
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                expanded && "rotate-180",
              )}
            />
            <Icon className="size-3.5 shrink-0" />
          </span>
        </TableCell>
        <TableCell className="h-8 max-w-0 py-1 text-xs">
          <span className="block min-w-0 truncate">{line}</span>
        </TableCell>
        {/*
         * `table-fixed` sizes the column but does not clip it, so a long title
         * would otherwise run the badge under the age beside it. The cell clips
         * and the badge yields.
         */}
        <TableCell className="h-8 overflow-hidden py-1">
          <Badge className="h-5 max-w-full text-[10px]" variant="outline">
            <span className="min-w-0 truncate">{title}</span>
          </Badge>
        </TableCell>
        <TableCell className="h-8 py-1">
          <DateTime className="text-xs" kind="time" value={event.createdAt} />
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell className={DETAIL_CELL_CLASS} colSpan={4}>
            <div
              className={cn(
                "w-full min-w-0 space-y-2 break-words",
                indent && "pl-5",
              )}
            >
              <ActivityDetail
                event={event}
                onToggleRaw={onToggleRaw}
                showRaw={showRaw}
              />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * Renders the grouped activity feed as `<TableBody>` rows. Codex item lifecycles
 * expose their underlying notifications; OpenCode text and tool lifecycles
 * expand directly into their combined or completed structured result.
 */
export function ActivityRows({ events }: { events: RunEventView[] }) {
  const t = useTranslations("runs");
  const locale = useLocale();
  const labels = useRunLabels();
  const nodes = useMemo(() => groupActivity(events), [events]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rawShown, setRawShown] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((current) => toggleKey(current, key));
  const toggleRaw = (key: string) =>
    setRawShown((current) => toggleKey(current, key));

  if (!events.length)
    return (
      <TableRow>
        <TableCell
          className="h-20 text-center text-muted-foreground"
          colSpan={4}
        >
          {t("noActivity")}
        </TableCell>
      </TableRow>
    );

  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "single") {
          const descriptor = describeActivity(node.event, locale);
          return (
            <ActivityRow
              event={node.event}
              expanded={expanded.has(node.key)}
              key={node.key}
              line={descriptor.line || node.event.summary}
              onToggle={() => toggleExpanded(node.key)}
              onToggleRaw={() => toggleRaw(node.event.id)}
              showRaw={rawShown.has(node.event.id)}
              title={
                descriptor.methodTitle ?? labels.eventType(node.event.type)
              }
            />
          );
        }
        const descriptor = describeActivity(node.representative, locale);
        const groupExpanded = expanded.has(node.key);
        const Icon = descriptor.icon;
        return (
          <Fragment key={node.key}>
            <TableRow
              aria-expanded={groupExpanded}
              className="cursor-pointer"
              onClick={() => toggleExpanded(node.key)}
            >
              <TableCell className="h-8 py-1">
                <span className="flex items-center gap-1">
                  <ChevronDown
                    className={cn(
                      "size-3 transition-transform",
                      groupExpanded && "rotate-180",
                    )}
                  />
                  <Icon className="size-3.5 shrink-0" />
                </span>
              </TableCell>
              <TableCell className="h-8 max-w-0 py-1 text-xs">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 truncate">
                    {descriptor.line || node.representative.summary}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {node.children.length}
                  </span>
                </span>
              </TableCell>
              <TableCell className="h-8 overflow-hidden py-1">
                <Badge className="h-5 max-w-full text-[10px]" variant="outline">
                  <span className="min-w-0 truncate">
                    {itemGroupTitle(node.representative)}
                  </span>
                </Badge>
              </TableCell>
              <TableCell className="h-8 py-1">
                <DateTime
                  className="text-xs"
                  kind="time"
                  value={node.head.createdAt}
                />
              </TableCell>
            </TableRow>
            {groupExpanded && node.detailMode === "representative" && (
              <TableRow className="hover:bg-transparent">
                <TableCell className={DETAIL_CELL_CLASS} colSpan={4}>
                  <div className="w-full min-w-0 space-y-2 break-words">
                    <ActivityDetail
                      event={node.representative}
                      onToggleRaw={() => toggleRaw(node.key)}
                      showRaw={rawShown.has(node.key)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {groupExpanded &&
              node.detailMode === "children" &&
              node.children.map((child) => {
                const childDescriptor = describeActivity(child, locale);
                return (
                  <ActivityRow
                    event={child}
                    expanded={expanded.has(child.id)}
                    indent
                    key={child.id}
                    line={childDescriptor.line || child.summary}
                    onToggle={() => toggleExpanded(child.id)}
                    onToggleRaw={() => toggleRaw(child.id)}
                    showRaw={rawShown.has(child.id)}
                    title={
                      childDescriptor.methodTitle ??
                      labels.eventType(child.type)
                    }
                  />
                );
              })}
          </Fragment>
        );
      })}
    </>
  );
}
