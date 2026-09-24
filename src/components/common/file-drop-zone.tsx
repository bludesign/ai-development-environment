"use client";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A dashed area that accepts dropped files or opens the file picker on click.
 * `onDropTransfer` receives the raw drop instead of its flattened file list,
 * for callers that need dropped folders, which the list leaves out.
 */
export function FileDropZone({
  accept,
  children,
  className,
  compact = false,
  disabled = false,
  multiple = true,
  onDropTransfer,
  onFiles,
}: {
  accept?: string;
  children: ReactNode;
  className?: string;
  compact?: boolean;
  disabled?: boolean;
  multiple?: boolean;
  onDropTransfer?: (transfer: DataTransfer) => void | Promise<void>;
  onFiles: (files: File[]) => void | Promise<void>;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <label
      className={cn(
        "relative flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-4 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground",
        compact ? "min-h-9" : "min-h-20",
        dragging && "border-primary bg-primary/5 text-primary",
        disabled && "pointer-events-none opacity-60",
        className,
      )}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (disabled) return;
        if (onDropTransfer) void onDropTransfer(event.dataTransfer);
        else void onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {children}
      <input
        accept={accept}
        className="sr-only"
        disabled={disabled}
        multiple={multiple}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void onFiles(files);
        }}
        type="file"
      />
    </label>
  );
}
