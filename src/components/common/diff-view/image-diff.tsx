"use client";

import { useState } from "react";
import Image from "next/image";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type ImageDiffLabels = {
  sideBySide: string;
  overlap: string;
  /** Accessible label for the overlap opacity slider. */
  transparency: string;
  before: string;
  after: string;
  /** Shown when one side of the comparison does not exist. */
  missing: string;
};

/**
 * Compares two image revisions, either side by side or stacked with an opacity
 * slider.
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
  const [mode, setMode] = useState<"OVERLAP" | "SIDE_BY_SIDE">("SIDE_BY_SIDE");
  const [opacity, setOpacity] = useState(50);
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
      ) : (
        <div className="relative min-h-64 overflow-hidden rounded-md border bg-[repeating-conic-gradient(#ddd_0_25%,#fff_0_50%)_0/20px_20px] dark:bg-[repeating-conic-gradient(#222_0_25%,#333_0_50%)_0/20px_20px]">
          {before && (
            <Image
              alt={labels.before}
              className="absolute inset-0 size-full object-contain"
              fill
              src={before}
              unoptimized
            />
          )}
          {after && (
            <Image
              alt={labels.after}
              className="absolute inset-0 size-full object-contain"
              fill
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
