"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortDirection = "asc" | "desc";

/**
 * A column heading that is also the control for sorting by that column. The
 * arrow carries the state: a neutral pair on every sortable column so it reads
 * as clickable, replaced on the active one by the direction it is sorted in.
 * `aria-sort` says the same thing to anyone not looking at the arrow.
 */
export function SortableTableHead({
  active,
  align = "left",
  ariaLabel,
  className,
  direction,
  label,
  onSort,
}: {
  active: boolean;
  align?: "left" | "right";
  ariaLabel: string;
  className?: string;
  direction: SortDirection;
  label: string;
  onSort: () => void;
}) {
  return (
    <TableHead
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
      className={cn("h-8 px-2", className)}
    >
      <Button
        aria-label={ariaLabel}
        className={cn(
          "-mx-2 h-7 px-2 text-xs",
          align === "right"
            ? "w-[calc(100%+1rem)] justify-end"
            : "justify-start",
        )}
        onClick={onSort}
        size="sm"
        title={ariaLabel}
        type="button"
        variant="ghost"
      >
        {label}
        {active ? (
          direction === "asc" ? (
            <ArrowUp />
          ) : (
            <ArrowDown />
          )
        ) : (
          <ArrowUpDown />
        )}
      </Button>
    </TableHead>
  );
}
