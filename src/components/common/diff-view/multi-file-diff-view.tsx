"use client";

import { useMemo, useState } from "react";
import { ChevronDown, FileCode2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { DiffView, type DiffViewLabels } from "./diff-view";
import { parseUnifiedPatch } from "./parse-patch";
import type { DiffViewMode } from "./types";

/**
 * A multi-file patch as collapsible per-file sections. Unlike the single-file
 * `DiffView` this takes raw patch text, because its callers hold whole-patch
 * blobs (stash diffs, run checkpoints) rather than per-file diffs.
 */
export function MultiFileDiffView({
  className,
  labels,
  mode = "UNIFIED",
  patch,
  truncated = false,
  wrap = false,
}: {
  className?: string;
  labels: DiffViewLabels;
  mode?: DiffViewMode;
  patch: string;
  truncated?: boolean;
  wrap?: boolean;
}) {
  const files = useMemo(() => parseUnifiedPatch(patch), [patch]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div
      className={cn("divide-y overflow-hidden rounded-md border", className)}
    >
      {files.map((file) => {
        const expanded = open.has(file.key);
        return (
          <div key={file.key}>
            <button
              aria-expanded={expanded}
              className="flex min-h-8 w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/40"
              onClick={() =>
                setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(file.key)) next.delete(file.key);
                  else next.add(file.key);
                  return next;
                })
              }
              type="button"
            >
              <ChevronDown
                className={cn(
                  "size-3.5 shrink-0 transition-transform",
                  expanded && "rotate-180",
                )}
              />
              <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {file.path}
              </span>
              <Badge className="h-5 px-1.5" variant="outline">
                {file.changeType}
              </Badge>
              <span className="text-xs text-diff-add-foreground tabular-nums">
                +{file.additions}
              </span>
              <span className="text-xs text-diff-delete-foreground tabular-nums">
                −{file.deletions}
              </span>
            </button>
            {expanded && (
              <div className="border-t bg-muted/10 p-3">
                <DiffView file={file} labels={labels} mode={mode} wrap={wrap} />
              </div>
            )}
          </div>
        );
      })}
      {truncated && (
        <p className="p-2 text-xs text-muted-foreground">{labels.truncated}</p>
      )}
    </div>
  );
}
