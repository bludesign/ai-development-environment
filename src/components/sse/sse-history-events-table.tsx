"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { formatEnumLabel } from "@/lib/enum-label";

import { ModeBadge } from "./sse-shell";
import {
  SseHistoryColumnHead,
  SseHistoryDayRow,
  sseHistoryDayKey,
} from "./sse-history-table-parts";
import type { SseHistoryEvent, SseHistoryRequest } from "./types";

export const STREAM_EVENT_COLUMNS = [
  "createdAt",
  "eventName",
  "stage",
  "eventId",
  "data",
  "sequence",
] as const;

const EVENT_COLUMN_LABELS: Record<string, string> = {
  endpoint: "Endpoint",
  createdAt: "Create At",
  eventName: "Event Name",
  stage: "Stage",
  eventId: "Event ID",
  data: "Data",
  sequence: "Sequence",
  mode: "Mode",
};

export function sseEventColumnLabel(column: string) {
  return EVENT_COLUMN_LABELS[column] ?? column;
}

function setSelectedRow(
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>,
  id: string,
  checked: boolean,
) {
  setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(id);
    else next.delete(id);
    return next;
  });
}

function stageBadge(event: SseHistoryEvent) {
  return (
    <Badge
      variant={
        event.stage === "DROPPED"
          ? "destructive"
          : event.stage === "EMITTED"
            ? "success"
            : "outline"
      }
    >
      {formatEnumLabel(event.stage)}
      {event.split ? " · Split" : ""}
    </Badge>
  );
}

function eventCell(event: SseHistoryEvent, column: string, hour12: boolean) {
  switch (column) {
    case "endpoint":
      return event.request?.endpointName ?? "Deleted endpoint";
    case "createdAt":
      return (
        <DateTime
          hour12={hour12}
          kind="time"
          value={event.createdAt}
        />
      );
    case "eventName":
      return <code>{event.eventName}</code>;
    case "stage":
      return stageBadge(event);
    case "eventId":
      return event.eventId ?? "—";
    case "data":
      return (
        <code className="line-clamp-2 max-w-2xl whitespace-pre-wrap text-xs">
          {event.data}
        </code>
      );
    case "sequence":
      return `${event.sequence}.${event.logicalIndex}`;
    case "mode":
      return event.request ? <ModeBadge mode={event.request.mode} /> : "—";
    default:
      return "—";
  }
}

function DetailValue({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function transformationBadges(event: SseHistoryEvent) {
  const transformed =
    event.dropped ||
    event.split ||
    event.fanOutIndex !== null ||
    event.truncated;
  if (!transformed) return "None";
  return (
    <span className="flex flex-wrap gap-1">
      {event.dropped ? <Badge variant="destructive">Dropped</Badge> : null}
      {event.split ? <Badge variant="outline">Split</Badge> : null}
      {event.fanOutIndex !== null ? (
        <Badge variant="outline">Fan-out {event.fanOutIndex + 1}</Badge>
      ) : null}
      {event.truncated ? <Badge variant="destructive">Truncated</Badge> : null}
    </span>
  );
}

export function SseHistoryEventDetails({
  event,
  stream,
  hour12 = true,
}: {
  event: SseHistoryEvent;
  stream?: SseHistoryRequest;
  hour12?: boolean;
}) {
  const request = event.request ?? stream;
  return (
    <div className="space-y-5 border-l-2 border-primary/30 bg-muted/15 p-4 sm:p-5">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <DetailValue label="Event Name">
          <code className="break-all">{event.eventName}</code>
        </DetailValue>
        <DetailValue label="Stage">{stageBadge(event)}</DetailValue>
        <DetailValue label="Create At">
          <DateTime hour12={hour12} value={event.createdAt} />
        </DetailValue>
        <DetailValue label="Sequence">
          {event.sequence}.{event.logicalIndex}
        </DetailValue>
        <DetailValue label="Event ID">
          <code className="break-all">{event.eventId ?? "—"}</code>
        </DetailValue>
        <DetailValue label="Retry">
          {event.retryMs === null ? "—" : `${event.retryMs} ms`}
        </DetailValue>
        <DetailValue label="Correlation ID">
          <code className="break-all">{event.correlationId}</code>
        </DetailValue>
        <DetailValue label="Transformation">
          {transformationBadges(event)}
        </DetailValue>
      </dl>
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Event Data
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border bg-background/70 p-3 text-xs">
          {event.data}
        </pre>
      </div>
      {request ? (
        <div className="flex flex-col gap-3 rounded-lg border bg-background/70 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{request.endpointName}</p>
              <ModeBadge mode={request.mode} />
              <Badge variant={request.error ? "destructive" : "outline"}>
                {formatEnumLabel(request.outcome ?? request.status)}
              </Badge>
            </div>
            <p className="break-all text-xs text-muted-foreground">
              <code>{request.method}</code> {request.requestUrl}
            </p>
          </div>
          <Button asChild className="shrink-0" size="sm" variant="outline">
            <Link href={`/sse/history/${request.id}`}>View Stream</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function SseHistoryEventsTable({
  rows,
  columns,
  selected,
  setSelected,
  stream,
  editMode = false,
  hour12 = true,
  onRemoveColumn,
}: {
  rows: SseHistoryEvent[];
  columns: readonly string[];
  selected?: Set<string>;
  setSelected?: React.Dispatch<React.SetStateAction<Set<string>>>;
  stream?: SseHistoryRequest;
  editMode?: boolean;
  hour12?: boolean;
  onRemoveColumn?: (column: string) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const selectable = selected !== undefined && setSelected !== undefined;
  const selectedRows = selected ?? new Set<string>();
  const showSelection = selectable && editMode;
  const idsByDay = new Map<string, string[]>();
  for (const row of rows) {
    const day = sseHistoryDayKey(row.createdAt);
    idsByDay.set(day, [...(idsByDay.get(day) ?? []), row.id]);
  }

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-8 w-20 px-2">
            {showSelection ? (
              <Checkbox
                aria-label="Select all events"
                checked={
                  rows.length > 0 &&
                  rows.every((row) => selectedRows.has(row.id))
                }
                onCheckedChange={(checked) =>
                  setSelected?.(
                    checked === true
                      ? new Set(rows.map((row) => row.id))
                      : new Set(),
                  )
                }
              />
            ) : (
              <span className="sr-only">Event details</span>
            )}
          </TableHead>
          {columns.map((column) => (
            <SseHistoryColumnHead
              key={column}
              label={sseEventColumnLabel(column)}
              onRemove={
                onRemoveColumn ? () => onRemoveColumn(column) : undefined
              }
              removable={columns.length > 1}
            />
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => {
          const expanded = expandedIds.has(row.id);
          const stage = formatEnumLabel(row.stage);
          const day = sseHistoryDayKey(row.createdAt);
          const dayIds = idsByDay.get(day) ?? [];
          const selectedDayCount = dayIds.filter((id) =>
            selectedRows.has(id),
          ).length;
          const showDay =
            index === 0 || sseHistoryDayKey(rows[index - 1]!.createdAt) !== day;
          return (
            <Fragment key={row.id}>
              {showDay ? (
                <SseHistoryDayRow
                  checked={
                    showSelection
                      ? selectedDayCount === dayIds.length
                        ? true
                        : selectedDayCount
                          ? "indeterminate"
                          : false
                      : undefined
                  }
                  colSpan={columns.length + 1}
                  onCheckedChange={
                    showSelection
                      ? (checked) =>
                          setSelected?.((current) => {
                            const next = new Set(current);
                            for (const id of dayIds) {
                              if (checked) next.add(id);
                              else next.delete(id);
                            }
                            return next;
                          })
                      : undefined
                  }
                  value={row.createdAt}
                />
              ) : null}
              <TableRow
                aria-expanded={expanded}
                aria-label={`${row.eventName} ${stage} event`}
                className="cursor-pointer focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                onClick={() => toggleExpanded(row.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggleExpanded(row.id);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <TableCell
                  className="px-2 py-1.5"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <div className="flex items-center gap-1">
                    {showSelection ? (
                      <Checkbox
                        aria-label={`Select ${row.eventName}`}
                        checked={selectedRows.has(row.id)}
                        onCheckedChange={(checked) =>
                          setSelected
                            ? setSelectedRow(
                                setSelected,
                                row.id,
                                checked === true,
                              )
                            : undefined
                        }
                      />
                    ) : null}
                    <Button
                      aria-label={
                        expanded
                          ? `Collapse ${row.eventName} ${stage} event`
                          : `Expand ${row.eventName} ${stage} event`
                      }
                      className="size-7"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleExpanded(row.id);
                      }}
                      size="icon-sm"
                      variant="ghost"
                    >
                      {expanded ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                  </div>
                </TableCell>
                {columns.map((column) => (
                  <TableCell className="px-2 py-1.5" key={column}>
                    {eventCell(row, column, hour12)}
                  </TableCell>
                ))}
              </TableRow>
              {expanded ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell className="p-0" colSpan={columns.length + 1}>
                    <SseHistoryEventDetails
                      event={row}
                      hour12={hour12}
                      stream={stream}
                    />
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
