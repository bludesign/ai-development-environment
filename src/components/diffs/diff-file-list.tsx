"use client";

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  Images,
  Search,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { CoverageValue } from "@/components/common/coverage-value";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

/** Left padding, in pixels, each level of folder nesting adds to a row. */
const INDENT = 12;

type FileNode = { type: "file"; file: DiffFileEntry };

type FolderNode = {
  type: "folder";
  /** Displayed segment(s) — several, once a single-child chain is collapsed. */
  label: string;
  /** Full path of the folder, used as its key and expansion identity. */
  path: string;
  children: TreeNode[];
};

type TreeNode = FileNode | FolderNode;

function compare(
  left: DiffFileEntry,
  right: DiffFileEntry,
  sort: DiffFileSort,
): number {
  switch (sort) {
    case "module":
      return (left.module ?? "").localeCompare(right.module ?? "");
    case "coverage":
      return (left.lineCoverage ?? 0) - (right.lineCoverage ?? 0);
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

/** Whole percentages keep the ring's label narrow enough for the sidebar. */
function percentLabel(value: unknown): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "—";
}

/** The part of a path shown on the row itself; the folders own the rest. */
function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * A folder whose only child is another folder carries no information of its
 * own, so the pair renders as one row (`src/components`) — the way an editor
 * tree does it. Groups only survive where a folder holds files, or more than
 * one child.
 */
function collapseChains(node: FolderNode): FolderNode {
  let current: FolderNode = {
    ...node,
    children: node.children.map((child) =>
      child.type === "folder" ? collapseChains(child) : child,
    ),
  };
  while (
    current.children.length === 1 &&
    current.children[0].type === "folder"
  ) {
    const only = current.children[0];
    current = {
      ...current,
      label: `${current.label}/${only.label}`,
      path: only.path,
      children: only.children,
    };
  }
  return current;
}

/**
 * Groups the (already sorted) files by folder. Folders keep the order their
 * first file appeared in, so the chosen sort still drives the list — and
 * folders precede loose files at every level.
 */
function buildTree(files: DiffFileEntry[]): TreeNode[] {
  const root: FolderNode = {
    type: "folder",
    label: "",
    path: "",
    children: [],
  };

  for (const file of files) {
    const segments = file.path.split("/");
    segments.pop();
    let parent = root;
    for (const segment of segments) {
      const path = parent.path ? `${parent.path}/${segment}` : segment;
      const existing = parent.children.find(
        (child): child is FolderNode =>
          child.type === "folder" && child.path === path,
      );
      if (existing) {
        parent = existing;
        continue;
      }
      const created: FolderNode = {
        type: "folder",
        label: segment,
        path,
        children: [],
      };
      parent.children.push(created);
      parent = created;
    }
    parent.children.push({ type: "file", file });
  }

  const order = (node: FolderNode): TreeNode[] => [
    ...node.children
      .filter((child): child is FolderNode => child.type === "folder")
      .map((child) => ({ ...child, children: order(child) })),
    ...node.children.filter((child) => child.type === "file"),
  ];

  // The root is a rendering fiction, so only its children get collapsed.
  return order(root).map((child) =>
    child.type === "folder" ? collapseChains(child) : child,
  );
}

function countFiles(node: TreeNode): number {
  return node.type === "file"
    ? 1
    : node.children.reduce((total, child) => total + countFiles(child), 0);
}

function FileRow({
  byCoverage,
  depth,
  file,
  onSelect,
  selected,
  showCoverage,
}: {
  /** Sorting by coverage: the row trades its change counts for the ring. */
  byCoverage: boolean;
  depth: number;
  file: DiffFileEntry;
  onSelect: (file: DiffFileEntry) => void;
  selected: boolean;
  showCoverage: boolean;
}) {
  return (
    // Names truncate in a sidebar this narrow, so hovering spells one out.
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-current={selected}
          className={cn(
            "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left hover:bg-accent",
            selected && "bg-accent",
          )}
          onClick={() => onSelect(file)}
          style={{ paddingLeft: depth * INDENT + 8 }}
          type="button"
        >
          {file.image ? (
            <Images className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs">
              {baseName(file.path)}
            </span>
            {/* The ring already carries the percentage when it is showing. */}
            {(file.module ||
              (showCoverage && !byCoverage && file.lineCoverage !== null)) && (
              <span className="block truncate text-[0.7rem] text-muted-foreground">
                {file.module}
                {file.module &&
                showCoverage &&
                !byCoverage &&
                file.lineCoverage !== null
                  ? " · "
                  : ""}
                {showCoverage && !byCoverage && file.lineCoverage !== null
                  ? `${Math.round(file.lineCoverage * 100)}%`
                  : ""}
              </span>
            )}
          </span>
          {byCoverage ? (
            <CoverageValue
              className="shrink-0 text-[0.7rem]"
              percent={percentLabel}
              value={file.lineCoverage}
            />
          ) : (
            <>
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
            </>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent className="font-mono" side="right">
        <span className="block break-all">{baseName(file.path)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function TreeRows({
  byCoverage,
  collapsed,
  depth,
  nodes,
  onSelect,
  onToggle,
  selectedKey,
  showCoverage,
}: {
  byCoverage: boolean;
  collapsed: (path: string) => boolean;
  depth: number;
  nodes: TreeNode[];
  onSelect: (file: DiffFileEntry) => void;
  onToggle: (path: string) => void;
  selectedKey: string | null;
  showCoverage: boolean;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.type === "file") {
          return (
            <li key={node.file.key}>
              <FileRow
                byCoverage={byCoverage}
                depth={depth}
                file={node.file}
                onSelect={onSelect}
                selected={node.file.key === selectedKey}
                showCoverage={showCoverage}
              />
            </li>
          );
        }
        const open = !collapsed(node.path);
        return (
          <li key={node.path}>
            <button
              aria-expanded={open}
              className="flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left hover:bg-accent"
              onClick={() => onToggle(node.path)}
              style={{ paddingLeft: depth * INDENT + 8 }}
              type="button"
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              {open ? (
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs font-medium"
                title={node.path}
              >
                {node.label}
              </span>
              <span className="shrink-0 text-[0.7rem] text-muted-foreground tabular-nums">
                {countFiles(node)}
              </span>
            </button>
            {open && (
              <ul className="space-y-0.5">
                <TreeRows
                  byCoverage={byCoverage}
                  collapsed={collapsed}
                  depth={depth + 1}
                  nodes={node.children}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  selectedKey={selectedKey}
                  showCoverage={showCoverage}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
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
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matched = needle
      ? files.filter(
          (file) =>
            file.path.toLocaleLowerCase().includes(needle) ||
            (file.module ?? "").toLocaleLowerCase().includes(needle),
        )
      : files;
    return [...matched].sort((left, right) => {
      if (
        sort === "coverage" &&
        (left.lineCoverage === null) !== (right.lineCoverage === null)
      ) {
        // Missing readings stay after measured files in both directions.
        return left.lineCoverage === null ? 1 : -1;
      }
      const result = compare(left, right, sort);
      // Ties fall back to path so the order is stable across re-sorts.
      if (result !== 0) return direction === "asc" ? result : -result;
      return left.path.localeCompare(right.path);
    });
  }, [direction, files, query, sort]);

  const tree = useMemo(() => buildTree(visible), [visible]);

  // While filtering, a folder the user collapsed earlier would hide matches.
  const searching = query.trim().length > 0;

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
        <TreeRows
          byCoverage={showCoverage && sort === "coverage"}
          collapsed={(path) => !searching && collapsed.has(path)}
          depth={0}
          nodes={tree}
          onSelect={onSelect}
          onToggle={(path) =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (!next.delete(path)) next.add(path);
              return next;
            })
          }
          selectedKey={selectedKey}
          showCoverage={showCoverage}
        />
        {!visible.length && (
          <li className="px-2 py-4 text-sm text-muted-foreground">
            {files.length ? t("noMatchingFiles") : t("noFiles")}
          </li>
        )}
      </ul>
    </div>
  );
}
