"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type { CrashFrame } from "./types";

function fileName(path: string) {
  return path.split("/").pop() ?? path;
}

export function frameLocation(frame: CrashFrame): string | null {
  if (!frame.sourceFile) return null;
  return `${fileName(frame.sourceFile)}:${frame.sourceLine ?? 0}`;
}

/** One backtrace, with app frames emphasized and inlined frames indented. */
export function FramesTable({ frames }: { frames: CrashFrame[] }) {
  const t = useTranslations("crashes");
  if (!frames.length) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">{t("noFrames")}</p>
    );
  }
  return (
    <ol className="divide-y font-mono text-xs">
      {frames.map((frame, position) => {
        const location = frameLocation(frame);
        return (
          <li
            className={cn(
              "grid grid-cols-[2rem_minmax(0,6rem)_minmax(0,1fr)] gap-x-3 px-4 py-1.5 sm:grid-cols-[2.5rem_minmax(0,11rem)_minmax(0,1fr)]",
              frame.isAppFrame
                ? "bg-primary/5 text-foreground"
                : "text-muted-foreground",
            )}
            key={`${frame.index}-${position}`}
          >
            {/* Inlined frames repeat their frame's number, as Apple's reports do. */}
            <span
              className={cn(
                "tabular-nums",
                frame.inlined && "text-muted-foreground",
              )}
            >
              {frame.index}
            </span>
            <span className="truncate" title={frame.imageName ?? undefined}>
              {frame.imageName ?? "???"}
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className={cn(frame.inlined && "pl-4")}>
                {frame.symbol ??
                  `${frame.address ?? "?"}${frame.imageOffset ? ` (${frame.imageName ?? "???"} + ${frame.imageOffset})` : ""}`}
              </span>
              {frame.symbolOffset !== null && !location ? (
                <span className="text-muted-foreground">
                  {" "}
                  + {frame.symbolOffset}
                </span>
              ) : null}
              {location ? (
                <span
                  className="text-muted-foreground"
                  title={frame.sourceFile ?? undefined}
                >
                  {" "}
                  ({location})
                </span>
              ) : null}
              {frame.inlined ? (
                <Badge className="ml-2" variant="outline">
                  {t("inlined")}
                </Badge>
              ) : null}
              {frame.symbolicated ? (
                <Badge className="ml-2" variant="secondary">
                  {t("fromDsym")}
                </Badge>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
