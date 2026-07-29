import {
  parsePatch,
  type StructuredPatch,
  type StructuredPatchHunk,
} from "diff";

import type {
  DiffChangeType,
  DiffHunk,
  DiffLine,
  DiffPairRow,
  ParsedDiffFile,
} from "./types";

/** Columns a tab advances by, matching the browser's default `tab-size`. */
const TAB_WIDTH = 8;

/**
 * How many columns a line occupies once rendered in the monospace grid. This is
 * not `content.length`: a tab jumps to the next tab stop rather than one column.
 * Double-width glyphs still count as one, so a CJK-heavy line under-measures.
 */
export function displayWidth(content: string): number {
  let width = 0;
  for (const char of content) {
    width = char === "\t" ? width + TAB_WIDTH - (width % TAB_WIDTH) : width + 1;
  }
  return width;
}

/**
 * Strips git's `a/` and `b/` path prefixes. `/dev/null` becomes null so callers
 * can tell an absent side from a real path.
 */
function stripPathPrefix(value: string | undefined): string | null {
  if (!value || value === "/dev/null") return null;
  const withoutTab = value.split("\t")[0]!;
  return withoutTab.replace(/^[ab]\//, "");
}

function changeTypeOf(file: StructuredPatch): DiffChangeType {
  if (file.isCreate) return "A";
  if (file.isDelete) return "D";
  if (file.isRename) return "R";
  if (file.isCopy) return "C";
  return "M";
}

/**
 * Walks a hunk's raw lines, resolving each into its old and new line numbers.
 * `\ No newline at end of file` is folded onto the preceding line rather than
 * becoming a row of its own.
 */
function hunkLines(hunk: StructuredPatchHunk, hunkKey: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const [index, raw] of hunk.lines.entries()) {
    if (raw.startsWith("\\")) {
      const previous = lines.at(-1);
      if (previous) previous.noNewline = true;
      continue;
    }
    const marker = raw.charAt(0);
    // Git writes an empty context line as a bare space, but some tools trim it.
    const content = raw === "" ? "" : raw.slice(1);
    const key = `${hunkKey}:${index}`;
    if (marker === "+") {
      lines.push({
        key,
        kind: "add",
        oldLine: null,
        newLine,
        content,
        noNewline: false,
      });
      newLine += 1;
    } else if (marker === "-") {
      lines.push({
        key,
        kind: "delete",
        oldLine,
        newLine: null,
        content,
        noNewline: false,
      });
      oldLine += 1;
    } else {
      lines.push({
        key,
        kind: "context",
        oldLine,
        newLine,
        content,
        noNewline: false,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return lines;
}

/**
 * Projects unified lines into side-by-side pairs. Consecutive deletions and
 * additions are buffered and zipped so a replaced line sits opposite its
 * replacement; a context line flushes the buffer and occupies both sides.
 */
export function pairHunkRows(lines: DiffLine[]): DiffPairRow[] {
  const rows: DiffPairRow[] = [];
  let deletions: DiffLine[] = [];
  let additions: DiffLine[] = [];
  const flush = () => {
    const length = Math.max(deletions.length, additions.length);
    for (let index = 0; index < length; index += 1) {
      const left = deletions[index] ?? null;
      const right = additions[index] ?? null;
      rows.push({
        key: `pair:${left?.key ?? "-"}:${right?.key ?? "-"}`,
        left,
        right,
      });
    }
    deletions = [];
    additions = [];
  };
  for (const line of lines) {
    if (line.kind === "delete") {
      deletions.push(line);
    } else if (line.kind === "add") {
      additions.push(line);
    } else {
      flush();
      rows.push({ key: `ctx:${line.key}`, left: line, right: line });
    }
  }
  flush();
  return rows;
}

function buildHunks(file: StructuredPatch, fileKey: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let previousOldEnd = 1;
  for (const [index, hunk] of file.hunks.entries()) {
    const key = `${fileKey}:h${index}`;
    const lines = hunkLines(hunk, key);
    hunks.push({
      key,
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      gapBefore: Math.max(0, hunk.oldStart - previousOldEnd),
      lines,
      rows: pairHunkRows(lines),
    });
    previousOldEnd = hunk.oldStart + hunk.oldLines;
  }
  return hunks;
}

/**
 * Parses a unified patch — including a multi-file `diff --git` patch — into a
 * renderable model.
 *
 * jsdiff's `parsePatch` already splits multi-file git patches and carries the
 * extended headers through as `isCreate` / `isDelete` / `isRename` / `isCopy` /
 * `isBinary`, so there is no need to pre-split on `diff --git`.
 */
export function parseUnifiedPatch(patch: string): ParsedDiffFile[] {
  if (!patch.trim()) return [];
  let files: StructuredPatch[];
  try {
    files = parsePatch(patch);
  } catch {
    return [];
  }
  return files.flatMap((file, index) => {
    const newPath = stripPathPrefix(file.newFileName);
    const oldPath = stripPathPrefix(file.oldFileName);
    const path = newPath ?? oldPath;
    // A patch with neither a path nor hunks carries nothing to render.
    if (!path && !file.hunks.length) return [];
    const resolvedPath = path ?? `Patch ${index + 1}`;
    const key = `${oldPath ?? ""}:${resolvedPath}:${index}`;
    const hunks = buildHunks(file, key);
    let additions = 0;
    let deletions = 0;
    let lineCount = 0;
    let maxLineNumber = 0;
    let maxLineWidth = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") additions += 1;
        if (line.kind === "delete") deletions += 1;
        lineCount += 1;
        maxLineNumber = Math.max(
          maxLineNumber,
          line.oldLine ?? 0,
          line.newLine ?? 0,
        );
        maxLineWidth = Math.max(maxLineWidth, displayWidth(line.content));
      }
    }
    return [
      {
        key,
        path: resolvedPath,
        previousPath: oldPath && oldPath !== resolvedPath ? oldPath : null,
        changeType: changeTypeOf(file),
        additions,
        deletions,
        binary: file.isBinary === true,
        hunks,
        lineCount,
        maxLineNumber,
        maxLineWidth,
      },
    ];
  });
}
