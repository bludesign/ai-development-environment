"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, FileCode2, Images, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SortDirection } from "@/components/common/sortable-table-head";
import { cn } from "@/lib/utils";

import type { DiffFileEntry, DiffFileSort } from "./types";

/**
 * The sidebar is too narrow for a sortable-header table, so sorting is a
 * explicit control pair rather than `SortableTableHead`.
 */
const SORTS: DiffFileSort[] = [
  "name",
  "module",
  "coverage",
  "additions",
  "deletions",
  "changeType",
];

function compare(
  left: DiffFileEntry,
  right: DiffFileEntry,
  sort: DiffFileSort,
): number {
  switch (sort) {
    case "module":
      return (left.module ?? "").localeCompare(right.module ?? "");
    case "coverage":
      // Files the report says nothing about sort last in either direction.
      return (left.lineCoverage ?? -1) - (right.lineCoverage ?? -1);
    case "additions":
      return (left.additions ?? 0) - (right.additions ?? 0);
    case "deletions":
      return (left.deletions ?? 0) - (right.deletions ?? 0);
    case "changeType":
      return left.changeType.localeCompare(right.changeType);
    default:
      return left.path.localeCompare(right.path);
  }
}

export function DiffFileList({
  files,
  onSelect,
  selectedKey,
  showCoverage,
  truncated,
}: {
  files: DiffFileEntry[];
  onSelect: (file: DiffFileEntry) => void;
  selectedKey: string | null;
  showCoverage: boolean;
  truncated: boolean;
}) {
  const t = useTranslations("diffs");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DiffFileSort>("name");
  const [direction, setDirection] = useState<SortDirection>("asc");

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matched = needle
      ? files.filter(
          (file) =>
            file.path.toLocaleLowerCase().includes(needle) ||
            (file.module ?? "").toLocaleLowerCase().includes(needle),
        )
      : files;
    const sorted = [...matched].sort((left, right) => {
      const result = compare(left, right, sort);
      // Ties fall back to path so the order is stable across re-sorts.
      return result !== 0 ? result : left.path.localeCompare(right.path);
    });
    return direction === "asc" ? sorted : sorted.reverse();
  }, [direction, files, query, sort]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="relative">
        <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <Input
          aria-label={t("searchFiles")}
          className="pl-9"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchFilesPlaceholder")}
          value={query}
        />
      </div>
      <div className="flex items-center gap-2">
        <Select
          onValueChange={(value) => setSort(value as DiffFileSort)}
          value={sort}
        >
          <SelectTrigger aria-label={t("sortFiles")} className="h-8 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.filter((value) => showCoverage || value !== "coverage").map(
              (value) => (
                <SelectItem key={value} value={value}>
                  {t(`fileSort.${value}`)}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
        <Button
          aria-label={
            direction === "asc" ? t("sortAscending") : t("sortDescending")
          }
          className="size-8"
          onClick={() =>
            setDirection((current) => (current === "asc" ? "desc" : "asc"))
          }
          size="icon"
          title={direction === "asc" ? t("sortAscending") : t("sortDescending")}
          variant="outline"
        >
          {direction === "asc" ? (
            <ArrowUp className="size-4" />
          ) : (
            <ArrowDown className="size-4" />
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("fileCount", { count: visible.length })}
        {truncated ? ` · ${t("fileListTruncated")}` : ""}
      </p>
      <ul
        aria-label={t("files")}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto"
      >
        {visible.map((file) => (
          <li key={file.key}>
            <button
              aria-current={file.key === selectedKey}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                file.key === selectedKey && "bg-accent",
              )}
              onClick={() => onSelect(file)}
              type="button"
            >
              {file.image ? (
                <Images className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate font-mono text-xs"
                  title={file.path}
                >
                  {file.path}
                </span>
                {(file.module ||
                  (showCoverage && file.lineCoverage !== null)) && (
                  <span className="block truncate text-[0.7rem] text-muted-foreground">
                    {file.module}
                    {file.module && showCoverage && file.lineCoverage !== null
                      ? " · "
                      : ""}
                    {showCoverage && file.lineCoverage !== null
                      ? `${Math.round(file.lineCoverage * 100)}%`
                      : ""}
                  </span>
                )}
              </span>
              <Badge className="h-5 shrink-0 px-1.5" variant="outline">
                {file.changeType}
              </Badge>
              <span className="shrink-0 text-[0.7rem] tabular-nums">
                <span className="text-diff-add-foreground">
                  +{file.additions ?? 0}
                </span>{" "}
                <span className="text-diff-delete-foreground">
                  −{file.deletions ?? 0}
                </span>
              </span>
            </button>
          </li>
        ))}
        {!visible.length && (
          <li className="px-2 py-4 text-sm text-muted-foreground">
            {files.length ? t("noMatchingFiles") : t("noFiles")}
          </li>
        )}
      </ul>
    </div>
  );
}
