"use client";

import { X } from "lucide-react";

import { DateTime } from "@/components/common/date-time";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { dayKey, formatDateValue } from "@/lib/date-format";

export function sseHistoryDayKey(value: string) {
  return dayKey(value) ?? `invalid:${value}`;
}

export function SseHistoryColumnHead({
  label,
  removable,
  onRemove,
}: {
  label: string;
  removable: boolean;
  onRemove?: () => void;
}) {
  return (
    <TableHead className="group h-8 px-2">
      <span className="flex items-center gap-1">
        <span>{label}</span>
        {onRemove ? (
          <Button
            aria-label={`Remove ${label} column`}
            className="size-5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            disabled={!removable}
            onClick={onRemove}
            size="icon-sm"
            variant="ghost"
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </span>
    </TableHead>
  );
}

export function SseHistoryDayRow({
  value,
  colSpan,
  checked,
  onCheckedChange,
}: {
  value: string;
  colSpan: number;
  checked?: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean) => void;
}) {
  const selectable = checked !== undefined && onCheckedChange !== undefined;
  const dayLabel = formatDateValue(value, "long", { showTime: false });
  return (
    <TableRow className="bg-muted/20 hover:bg-muted/20">
      {selectable ? (
        <TableCell className="px-2 py-1.5">
          <Checkbox
            aria-label={`Select ${dayLabel}`}
            checked={checked}
            onCheckedChange={(value) => onCheckedChange(value === true)}
          />
        </TableCell>
      ) : null}
      <TableCell
        className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
        colSpan={colSpan - (selectable ? 1 : 0)}
      >
        <DateTime hover={false} kind="long" showTime={false} value={value} />
      </TableCell>
    </TableRow>
  );
}
