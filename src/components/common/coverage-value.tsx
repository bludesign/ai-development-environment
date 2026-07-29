"use client";

import { cn } from "@/lib/utils";

/**
 * A coverage percentage beside the ring that encodes it: a conic gradient
 * filled to the value, colored by the thresholds every coverage surface shares.
 * Non-numeric coverage — a file no report measured — renders as an em dash.
 */
export function CoverageValue({
  className,
  percent,
  size = "compact",
  value,
}: {
  className?: string;
  /** Formats the number for display; call sites own the locale and precision. */
  percent: (value: unknown) => string;
  size?: "compact" | "metric";
  value: unknown;
}) {
  if (typeof value !== "number") return <>—</>;
  const normalized = Math.max(0, Math.min(1, value));
  const color =
    normalized >= 0.8
      ? "text-emerald-500"
      : normalized >= 0.5
        ? "text-amber-500"
        : "text-red-500";
  return (
    <span
      className={cn(
        "inline-flex items-center tabular-nums",
        size === "metric" ? "gap-2 text-2xl font-semibold" : "gap-1.5",
        className,
      )}
    >
      {percent(value)}
      <span
        aria-hidden="true"
        className={cn(
          "shrink-0 rounded-full ring-1 ring-foreground/10",
          size === "metric" ? "size-7" : "size-3.5",
          color,
        )}
        data-coverage-indicator
        style={{
          background: `conic-gradient(currentColor ${normalized * 360}deg, var(--muted) 0deg)`,
        }}
      />
    </span>
  );
}
