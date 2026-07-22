"use client";

import { cn } from "@/lib/utils";

/**
 * A unified diff, colored per line. Scrolls horizontally on its own so a long
 * line never widens whatever contains it — inside a table cell, give the cell
 * `max-w-0` so it cannot claim the line's full width.
 */
export function PatchView({
  patch,
  truncated = false,
  truncatedLabel,
  className,
}: {
  patch: string;
  truncated?: boolean;
  /** Shown when `truncated`; required for the note to appear. */
  truncatedLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-auto rounded-md border bg-neutral-950 font-mono text-xs text-neutral-100",
        className,
      )}
    >
      {patch.split("\n").map((line, index) => (
        <div
          className={cn(
            "min-w-max px-3 whitespace-pre",
            line.startsWith("+") &&
              !line.startsWith("+++") &&
              "bg-emerald-950/70 text-emerald-200",
            line.startsWith("-") &&
              !line.startsWith("---") &&
              "bg-red-950/70 text-red-200",
            line.startsWith("@@") && "bg-blue-950/60 text-blue-200",
          )}
          key={`${index}:${line}`}
        >
          {line || " "}
        </div>
      ))}
      {truncated && truncatedLabel && (
        <p className="border-t p-2 text-amber-300">{truncatedLabel}</p>
      )}
    </div>
  );
}
