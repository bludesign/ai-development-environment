import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Lucide's signal icons draw only the bars they light up, so `low` and `high`
 * differ by absent strokes rather than dim ones and the scale is impossible to
 * read at a glance. Drawing every bar and dimming the unreached ones gives the
 * reader the whole scale plus a position on it.
 *
 * Codex exposes six ranked levels, so the scale needs six bars: collapsing the
 * top of it would render `xhigh`, `max`, and `ultra` identically in a strip
 * where they sit side by side as separate choices.
 */
const effortBars: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6,
};

const barCount = 6;

export function EffortIcon({
  className,
  effort,
}: {
  className?: string;
  effort: string | null;
}) {
  const bars = effortBars[effort?.toLowerCase() ?? "auto"];
  /** `auto` is the provider choosing for you, which is not a point on the scale. */
  if (!bars) {
    return (
      <Sparkles
        aria-hidden="true"
        className={cn("h-4 w-5 shrink-0", className)}
      />
    );
  }
  return (
    <svg
      aria-hidden="true"
      className={cn("h-4 w-5 shrink-0", className)}
      fill="currentColor"
      viewBox="0 0 20 16"
      xmlns="http://www.w3.org/2000/svg"
    >
      {Array.from({ length: barCount }, (_, index) => {
        const height = 2.5 + index * 2;
        return (
          <rect
            height={height}
            key={index}
            opacity={index < bars ? 1 : 0.25}
            rx={0.6}
            width={2}
            x={1.5 + index * 3}
            y={14 - height}
          />
        );
      })}
    </svg>
  );
}
