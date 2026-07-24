import { Cpu } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Lucide's signal icons draw only the bars they light up, so `low` and `high`
 * differ by absent strokes rather than dim ones and the scale is impossible to
 * read at a glance. Drawing every bar and dimming the unreached ones gives the
 * reader the whole scale plus a position on it.
 *
 * How deep that scale runs is a property of the model, not of the effort:
 * Codex ranks six levels and Claude five, so `high` is the middle of one ramp
 * and past the middle of the other. Passing the model's own list keeps the
 * icon honest about how much headroom is left above the current choice.
 */
const defaultScale = ["low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * `ultra` is the ceiling of the deepest ramp on offer, and a sixth identical
 * bar is a weak way to say "there is nothing above this". The spectrum marks
 * it as the end of the road rather than one more step. These are literal hex
 * values because a spectrum is not a themeable role; each stop was picked to
 * hold contrast on both the light and dark popover surfaces.
 */
const ultraSpectrum = [
  "#38bdf8",
  "#818cf8",
  "#a78bfa",
  "#e879f9",
  "#fb7185",
  "#fb923c",
];

const viewWidth = 20;
const sideMargin = 1.5;
const gap = 1;
const maxBarWidth = 5;
const baseline = 14;
const minBarHeight = 2.5;
const maxBarHeight = 12.5;

export function EffortIcon({
  className,
  effort,
  efforts,
}: {
  className?: string;
  effort: string | null;
  /**
   * The model's ranked levels. Omit where the catalog is not loaded — the run
   * list only knows a run's effort — and the icon falls back to the deepest
   * ramp any tool offers.
   */
  efforts?: string[];
}) {
  const value = effort?.toLowerCase() ?? "auto";
  const scale = (efforts ?? defaultScale)
    .map((entry) => entry.toLowerCase())
    .filter((entry) => entry !== "auto");
  const filled = scale.indexOf(value) + 1;
  /** `auto` is the provider choosing for you, which is not a point on the scale. */
  if (!filled) {
    return (
      <Cpu aria-hidden="true" className={cn("h-4 w-5 shrink-0", className)} />
    );
  }
  const span = scale.length - 1;
  const width = Math.min(
    maxBarWidth,
    (viewWidth - sideMargin * 2 - gap * span) / scale.length,
  );
  const start = (viewWidth - (scale.length * width + gap * span)) / 2;
  /**
   * A two-level ramp — OpenCode ranks only `low` and `high` — drawn against the
   * floor a six-level ramp needs reads as a cliff rather than a scale, so the
   * floor rises as the scale shortens.
   */
  const floor = Math.max(minBarHeight, maxBarHeight / (scale.length + 1));
  return (
    <svg
      aria-hidden="true"
      className={cn("h-4 w-5 shrink-0", className)}
      viewBox={`0 0 ${viewWidth} 16`}
      xmlns="http://www.w3.org/2000/svg"
    >
      {scale.map((level, index) => {
        const height = span
          ? floor + ((maxBarHeight - floor) * index) / span
          : maxBarHeight;
        const lit = index < filled;
        return (
          <rect
            fill={
              lit && value === "ultra"
                ? ultraSpectrum[
                    Math.round(
                      (index / (span || 1)) * (ultraSpectrum.length - 1),
                    )
                  ]
                : "currentColor"
            }
            height={height}
            key={level}
            opacity={lit ? 1 : 0.25}
            rx={0.6}
            width={width}
            x={start + index * (width + gap)}
            y={baseline - height}
          />
        );
      })}
    </svg>
  );
}
