"use client";

import { Columns2, Rows3, WrapText } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  ImageDiff,
  PatchDiffView,
  useDiffViewLabels,
  useImageDiffLabels,
  type DiffViewMode,
  type LineCoverageLookup,
} from "@/components/common/diff-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { DiffFileEntry, DiffScope } from "./types";
import { useDiffRequest } from "./use-diff-request";

/**
 * The right-hand pane: view controls, then the selected file's diff. Images and
 * text diffs come back through the same request, distinguished by the `image`
 * flag the agent sets from the file extension.
 */
export function DiffPane({
  commitSha,
  coverage,
  coverageStale,
  file,
  mode,
  onModeChange,
  onWrapChange,
  resetToken,
  scope,
  worktreeId,
  wrap,
}: {
  commitSha: string | null;
  /** Absent when no report is selected, or when it never measured this file. */
  coverage?: LineCoverageLookup;
  coverageStale: boolean;
  file: DiffFileEntry | null;
  mode: DiffViewMode;
  onModeChange: (mode: DiffViewMode) => void;
  onWrapChange: (wrap: boolean) => void;
  resetToken: string;
  scope: DiffScope;
  worktreeId: string;
  wrap: boolean;
}) {
  const t = useTranslations("diffs");
  const diffLabels = useDiffViewLabels();
  const imageLabels = useImageDiffLabels();
  const { value, loading, error } = useDiffRequest(
    file
      ? {
          worktreeId,
          scope,
          path: file.path,
          previousPath: file.previousPath,
          commitSha,
        }
      : null,
    resetToken,
  );

  const imageUrl = (side: "AFTER" | "BEFORE") => {
    if (!file) return "";
    const params = new URLSearchParams({ scope, path: file.path, side });
    if (file.previousPath) params.set("previousPath", file.previousPath);
    if (commitSha) params.set("commitSha", commitSha);
    return `/api/worktrees/${encodeURIComponent(worktreeId)}/diff-image?${params}`;
  };

  if (!file) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-md border text-sm text-muted-foreground">
        {t("selectAFile")}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-sm"
          title={file.path}
        >
          {file.previousPath && (
            <span className="text-muted-foreground">
              {file.previousPath} →{" "}
            </span>
          )}
          {file.path}
        </span>
        <Badge variant="outline">{file.changeType}</Badge>
        <div className="flex items-center gap-1">
          <Button
            aria-label={t("unifiedView")}
            aria-pressed={mode === "UNIFIED"}
            className={cn(mode === "UNIFIED" && "bg-accent")}
            onClick={() => onModeChange("UNIFIED")}
            size="icon"
            title={t("unifiedView")}
            variant="outline"
          >
            <Rows3 className="size-4" />
          </Button>
          <Button
            aria-label={t("splitView")}
            aria-pressed={mode === "SPLIT"}
            className={cn(mode === "SPLIT" && "bg-accent")}
            onClick={() => onModeChange("SPLIT")}
            size="icon"
            title={t("splitView")}
            variant="outline"
          >
            <Columns2 className="size-4" />
          </Button>
          <Button
            aria-label={t("toggleWrap")}
            aria-pressed={wrap}
            className={cn(wrap && "bg-accent")}
            onClick={() => onWrapChange(!wrap)}
            size="icon"
            title={t("toggleWrap")}
            variant="outline"
          >
            <WrapText className="size-4" />
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loadingDiff")}
        </p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : value?.image ? (
        <ImageDiff
          after={value.afterAvailable ? imageUrl("AFTER") : null}
          before={value.beforeAvailable ? imageUrl("BEFORE") : null}
          labels={imageLabels}
        />
      ) : value?.patch ? (
        <PatchDiffView
          coverage={coverage}
          coverageStale={coverageStale}
          labels={diffLabels}
          mode={mode}
          patch={value.patch}
          truncated={value.truncated}
          wrap={wrap}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {value?.truncated
            ? t("diffTooLarge")
            : value?.binary
              ? t("binaryFile")
              : t("noTextChanges")}
        </p>
      )}
    </div>
  );
}
