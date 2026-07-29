"use client";

import pixelmatch from "pixelmatch";
import { useEffect, useState, type ReactNode } from "react";
import Image from "next/image";

import { Spinner } from "@/components/ui/spinner";

/**
 * How the mask paints changed pixels. `RED` and `GREEN` mark them over the
 * "after" revision in full colour; `WHITE` is pixelmatch's own rendering, which
 * fades everything that matched towards white and marks the rest in red.
 */
export type PixelDiffColor = "GREEN" | "RED" | "WHITE";

/** Tailwind's `red-500` and `green-500`, so the swatches match the mask. */
const MASK_COLORS: Record<PixelDiffColor, [number, number, number]> = {
  GREEN: [34, 197, 94],
  RED: [239, 68, 68],
  WHITE: [239, 68, 68],
};

/** How much of the original survives in `WHITE`, on pixelmatch's 0–1 scale. */
const FADED_ALPHA = 0.2;

export type PixelDiffLabels = {
  /** Accessible label for the rendered difference mask. */
  difference: string;
  /** Reports how much of the image changed, e.g. "3.4% of pixels differ". */
  differenceSummary: (percent: string) => string;
  /** Shown while the comparison runs. */
  comparing: string;
  /** Shown when only one side of the comparison exists. */
  needsBothSides: string;
  /** Shown when an image could not be decoded or compared. */
  failed: string;
  /** Shown when the two revisions are pixel-identical. */
  identical: string;
};

/**
 * Pixels above this budget are downscaled before comparison. Pixelmatch runs on
 * the main thread, and a full-resolution retina screenshot pair is enough work
 * to visibly stall the pane.
 */
const MAX_PIXELS = 8_000_000;

type Result = {
  changed: number;
  total: number;
  url: string;
  height: number;
  width: number;
};

/**
 * Marks everything that changed between two image revisions with a pixelmatch
 * mask, painted over the "after" revision unless `color` asks for pixelmatch's
 * own faded rendering.
 *
 * Sides of differing size are compared on a canvas sized to the larger of the
 * two, so the extra rows or columns show up as changed rather than failing the
 * comparison outright.
 */
export function PixelDiff({
  after,
  before,
  color,
  labels,
  threshold,
}: {
  after: string | null;
  before: string | null;
  color: PixelDiffColor;
  labels: PixelDiffLabels;
  threshold: number;
}) {
  // Keyed by source rather than reset in the effect: a new threshold or colour
  // should keep the previous mask on screen while it recomputes — dragging the
  // sensitivity slider would otherwise flash the spinner on every step — but a
  // different file must never show the mask belonging to the last one.
  const sourceKey = `${before ?? ""}|${after ?? ""}`;
  const settingsKey = `${threshold}|${color}`;
  const [state, setState] = useState<{
    failed: boolean;
    result: Result | null;
    settings: string;
    source: string;
  } | null>(null);
  const current = state?.source === sourceKey ? state : null;

  useEffect(() => {
    if (!after || !before) return;
    let cancelled = false;
    const source = `${before}|${after}`;
    const settings = `${threshold}|${color}`;
    compare(before, after, threshold, color)
      .then((result) => {
        if (!cancelled) setState({ failed: false, result, settings, source });
      })
      .catch(() => {
        if (!cancelled)
          setState({ failed: true, result: null, settings, source });
      });
    return () => {
      cancelled = true;
    };
  }, [after, before, color, threshold]);

  if (!after || !before) {
    return <Message text={labels.needsBothSides} />;
  }
  if (current?.failed) {
    return <Message text={labels.failed} />;
  }
  const result = current?.result;
  if (!result) {
    return (
      <Message>
        <Spinner /> {labels.comparing}
      </Message>
    );
  }

  const stale = current.settings !== settingsKey;
  const percent = ((result.changed / result.total) * 100).toFixed(2);
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border bg-[repeating-conic-gradient(#ddd_0_25%,#fff_0_50%)_0/20px_20px] dark:bg-[repeating-conic-gradient(#222_0_25%,#333_0_50%)_0/20px_20px]">
        <Image
          alt={labels.difference}
          className="h-auto max-h-[36rem] w-full object-contain"
          height={result.height}
          src={result.url}
          unoptimized
          width={result.width}
        />
      </div>
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {stale
          ? labels.comparing
          : result.changed === 0
            ? labels.identical
            : labels.differenceSummary(percent)}
      </p>
    </div>
  );
}

function Message({ children, text }: { children?: ReactNode; text?: string }) {
  return (
    <div className="flex min-h-64 items-center justify-center gap-2 rounded-md border text-sm text-muted-foreground">
      {children ?? text}
    </div>
  );
}

async function compare(
  before: string,
  after: string,
  threshold: number,
  color: PixelDiffColor,
): Promise<Result> {
  const [beforeImage, afterImage] = await Promise.all([
    loadImage(before),
    loadImage(after),
  ]);

  const naturalWidth = Math.max(
    beforeImage.naturalWidth,
    afterImage.naturalWidth,
  );
  const naturalHeight = Math.max(
    beforeImage.naturalHeight,
    afterImage.naturalHeight,
  );
  if (naturalWidth === 0 || naturalHeight === 0) {
    throw new Error("Image has no intrinsic size");
  }

  const scale = Math.min(
    1,
    Math.sqrt(MAX_PIXELS / (naturalWidth * naturalHeight)),
  );
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const beforeData = toImageData(beforeImage, width, height, scale);
  const afterData = toImageData(afterImage, width, height, scale);
  // Away from `WHITE`, `diffMask` leaves everything that matched transparent so
  // the mask can be composited over the real "after" pixels, rather than over
  // pixelmatch's washed-out greyscale — which buries the context the reader
  // needs to tell *where* in the screenshot the marks are landing.
  const faded = color === "WHITE";
  const mask = new ImageData(width, height);
  const changed = pixelmatch(
    beforeData.data,
    afterData.data,
    mask.data,
    width,
    height,
    {
      alpha: FADED_ALPHA,
      diffColor: MASK_COLORS[color],
      // Both directions of change get the selected colour; the alternate colour
      // is pixelmatch's way of splitting darker-than from lighter-than, which
      // would defeat the point of choosing one.
      diffColorAlt: MASK_COLORS[color],
      diffMask: !faded,
      includeAA: false,
      threshold,
    },
  );

  const canvas = createCanvas(width, height);
  if (faded) {
    canvas.context.putImageData(mask, 0, 0);
  } else {
    canvas.context.drawImage(
      afterImage,
      0,
      0,
      Math.max(1, Math.round(afterImage.naturalWidth * scale)),
      Math.max(1, Math.round(afterImage.naturalHeight * scale)),
    );
    const maskCanvas = createCanvas(width, height);
    maskCanvas.context.putImageData(mask, 0, 0);
    canvas.context.drawImage(maskCanvas.element, 0, 0);
  }
  return {
    changed,
    height,
    total: width * height,
    url: canvas.element.toDataURL("image/png"),
    width,
  };
}

/**
 * Draws one side onto a canvas of the shared comparison size. Sides smaller
 * than that stay anchored at the top left, leaving the remainder transparent.
 */
function toImageData(
  image: HTMLImageElement,
  width: number,
  height: number,
  scale: number,
): ImageData {
  const { context } = createCanvas(width, height);
  context.drawImage(
    image,
    0,
    0,
    Math.max(1, Math.round(image.naturalWidth * scale)),
    Math.max(1, Math.round(image.naturalHeight * scale)),
  );
  return context.getImageData(0, 0, width, height);
}

function createCanvas(width: number, height: number) {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  const context = element.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D context unavailable");
  return { context, element };
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () =>
      reject(new Error(`Could not load ${url}`)),
    );
    image.src = url;
  });
}
