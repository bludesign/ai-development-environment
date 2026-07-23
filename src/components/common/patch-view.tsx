"use client";

import { useMemo, useState } from "react";
import { ChevronDown, FileCode2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type PatchFile = {
  key: string;
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "A" | "D" | "M" | "R";
};

function patchFiles(patch: string): PatchFile[] {
  const lines = patch.split("\n");
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length) {
      sections.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.some(Boolean)) sections.push(current);
  return sections.map((section, index) => {
    const header = section.find((line) => line.startsWith("diff --git "));
    const match = header?.match(/^diff --git a\/(.+) b\/(.+)$/);
    const oldPath = match?.[1];
    const newPath = match?.[2];
    const added = section.some((line) => line.startsWith("new file mode"));
    const deleted = section.some((line) =>
      line.startsWith("deleted file mode"),
    );
    const renamed = section.some((line) => line.startsWith("rename from "));
    const path =
      newPath ??
      section
        .find((line) => line.startsWith("+++ "))
        ?.replace(/^\+\+\+ (?:b\/)?/, "") ??
      oldPath ??
      `Patch ${index + 1}`;
    return {
      key: `${oldPath ?? ""}:${path}:${index}`,
      path,
      patch: section.join("\n"),
      additions: section.filter(
        (line) => line.startsWith("+") && !line.startsWith("+++"),
      ).length,
      deletions: section.filter(
        (line) => line.startsWith("-") && !line.startsWith("---"),
      ).length,
      status: added ? "A" : deleted ? "D" : renamed ? "R" : "M",
    };
  });
}

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

export function ExpandablePatchView({
  patch,
  className,
}: {
  patch: string;
  className?: string;
}) {
  const files = useMemo(() => patchFiles(patch), [patch]);
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
                {file.status}
              </Badge>
              <span className="text-xs text-emerald-600 tabular-nums">
                +{file.additions}
              </span>
              <span className="text-xs text-red-600 tabular-nums">
                −{file.deletions}
              </span>
            </button>
            {expanded && (
              <div className="border-t bg-muted/10 p-3">
                <PatchView patch={file.patch} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
