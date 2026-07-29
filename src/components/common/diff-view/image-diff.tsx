"use client";

import { useState, type SyntheticEvent } from "react";
import Image from "next/image";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { PixelDiff, type PixelDiffLabels } from "./pixel-diff";

export type ImageDiffLabels = PixelDiffLabels & {
  sideBySide: string;
  overlap: string;
  /** Accessible label for the overlap opacity slider. */
  transparency: string;
  /** Accessible label for the pixel-difference sensitivity slider. */
  sensitivity: string;
  before: string;
  after: string;
  /** Shown when one side of the comparison does not exist. */
  missing: string;
};

/** Pixelmatch's own default colour-distance cutoff, as a percentage. */
const DEFAULT_SENSITIVITY = 10;

/**
 * Compares two image revisions side by side, stacked with an opacity slider, or
 * as a pixelmatch mask of what changed.
 *
 * Takes resolved URLs rather than diff coordinates so it stays independent of
 * how a caller addresses its blobs. Both sides are `unoptimized` because the
 * URLs are one-shot authenticated endpoints the image optimizer cannot re-fetch.
 */
export function ImageDiff({
  after,
  before,
  labels,
}: {
  after: string | null;
  before: string | null;
  labels: ImageDiffLabels;
}) {
  const [mode, setMode] = useState<"DIFFERENCE" | "OVERLAP" | "SIDE_BY_SIDE">(
    "SIDE_BY_SIDE",
  );
  const [opacity, setOpacity] = useState(50);
  const [sensitivity, setSensitivity] = useState(DEFAULT_SENSITIVITY);
  // `fill` images have no intrinsic size, so the overlap box has to be told its
  // proportions or it collapses to `min-h-64` and letterboxes a wide image
  // instead of spanning the pane. Measure the base image once it decodes, keyed
  // by source so a different file does not inherit the previous ratio.
  const sourceKey = `${before ?? ""}|${after ?? ""}`;
  const [measured, setMeasured] = useState<{
    key: string;
    ratio: number;
  } | null>(null);
  const aspectRatio = measured?.key === sourceKey ? measured.ratio : null;
  const measure = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalHeight, naturalWidth } = event.currentTarget;
    if (naturalHeight > 0 && naturalWidth > 0) {
      setMeasured({ key: sourceKey, ratio: naturalWidth / naturalHeight });
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => setMode("SIDE_BY_SIDE")}
          size="sm"
          variant={mode === "SIDE_BY_SIDE" ? "default" : "outline"}
        >
          {labels.sideBySide}
        </Button>
        <Button
          onClick={() => setMode("OVERLAP")}
          size="sm"
          variant={mode === "OVERLAP" ? "default" : "outline"}
        >
          {labels.overlap}
        </Button>
        <Button
          onClick={() => setMode("DIFFERENCE")}
          size="sm"
          variant={mode === "DIFFERENCE" ? "default" : "outline"}
        >
          {labels.difference}
        </Button>
        {mode === "OVERLAP" && (
          <Input
            aria-label={labels.transparency}
            className="w-48"
            max={100}
            min={0}
            onChange={(event) => setOpacity(Number(event.target.value))}
            type="range"
            value={opacity}
          />
        )}
        {mode === "DIFFERENCE" && (
          <Input
            aria-label={labels.sensitivity}
            className="w-48"
            max={50}
            min={0}
            onChange={(event) => setSensitivity(Number(event.target.value))}
            type="range"
            value={sensitivity}
          />
        )}
      </div>
      {mode === "SIDE_BY_SIDE" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <ImageSide
            label={labels.before}
            missing={labels.missing}
            url={before}
          />
          <ImageSide
            label={labels.after}
            missing={labels.missing}
            url={after}
          />
        </div>
      ) : mode === "DIFFERENCE" ? (
        <PixelDiff
          after={after}
          before={before}
          labels={labels}
          threshold={sensitivity / 100}
        />
      ) : (
        <div
          className={cn(
            "relative w-full max-h-[36rem] overflow-hidden rounded-md border bg-[repeating-conic-gradient(#ddd_0_25%,#fff_0_50%)_0/20px_20px] dark:bg-[repeating-conic-gradient(#222_0_25%,#333_0_50%)_0/20px_20px]",
            aspectRatio === null && "min-h-64",
          )}
          style={aspectRatio === null ? undefined : { aspectRatio }}
        >
          {before && (
            <Image
              alt={labels.before}
              className="absolute inset-0 size-full object-contain"
              fill
              onLoad={measure}
              src={before}
              unoptimized
            />
          )}
          {after && (
            <Image
              alt={labels.after}
              className="absolute inset-0 size-full object-contain"
              fill
              onLoad={before ? undefined : measure}
              src={after}
              style={{ opacity: opacity / 100 }}
              unoptimized
            />
          )}
          {!before && !after && <MissingImage label={labels.missing} />}
        </div>
      )}
    </div>
  );
}

function ImageSide({
  label,
  missing,
  url,
}: {
  label: string;
  missing: string;
  url: string | null;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-md border bg-muted/30">
        {url ? (
          <Image
            alt={label}
            className="max-h-[36rem] max-w-full object-contain"
            height={1024}
            src={url}
            unoptimized
            width={1024}
          />
        ) : (
          <MissingImage label={missing} />
        )}
      </div>
    </div>
  );
}

function MissingImage({ label }: { label: string }) {
  return <span className="text-sm text-muted-foreground">{label}</span>;
}
