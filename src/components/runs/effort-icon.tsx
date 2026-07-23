import {
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Effort reads as signal strength: more bars, more thinking. `auto` has no
 * place on that scale — empty bars would read as "none" — so it keeps the
 * sparkles that stand for a provider-chosen effort.
 */
export function EffortIcon({
  className,
  effort,
}: {
  className?: string;
  effort: string | null;
}) {
  const value = effort?.toLowerCase() ?? "auto";
  const Icon =
    value === "low"
      ? SignalLow
      : value === "medium"
        ? SignalMedium
        : value === "high"
          ? SignalHigh
          : value === "xhigh" || value === "max" || value === "ultra"
            ? Signal
            : Sparkles;
  return (
    <Icon aria-hidden="true" className={cn("size-4 shrink-0", className)} />
  );
}
