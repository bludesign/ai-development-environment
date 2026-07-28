/** Which side of a diff a row belongs to. */
export type DiffSide = "LEFT" | "RIGHT";

/** How a diff line relates to the two files being compared. */
export type DiffLineKind = "context" | "add" | "delete";

/** How a file changed between the two sides of a diff. */
export type DiffChangeType = "A" | "C" | "D" | "M" | "R";

/** Whether a rendered diff pairs the two sides or interleaves them. */
export type DiffViewMode = "SPLIT" | "UNIFIED";

/** Whether a line was executed by the selected coverage report. */
export type DiffCoverageState = "covered" | "uncovered";

/**
 * Resolves the coverage state of a line in the file's new revision. Returns
 * null for lines the report says nothing about, including non-executable ones.
 */
export type LineCoverageLookup = (newLine: number) => DiffCoverageState | null;

/** A single row of a unified diff, with both revisions' line numbers resolved. */
export type DiffLine = {
  key: string;
  kind: DiffLineKind;
  /** Line number in the old revision; null on added lines. */
  oldLine: number | null;
  /** Line number in the new revision; null on deleted lines. */
  newLine: number | null;
  /** Line text with the leading +/-/space marker removed. */
  content: string;
  /** Whether git reported no trailing newline after this line. */
  noNewline: boolean;
};

/** A pair of lines shown opposite each other in split mode. */
export type DiffPairRow = {
  key: string;
  left: DiffLine | null;
  right: DiffLine | null;
};

/** One `@@` section of a diff, in both its unified and split projections. */
export type DiffHunk = {
  key: string;
  /** Reconstructed `@@ -a,b +c,d @@` header. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Lines skipped since the previous hunk, or since the start of the file. */
  gapBefore: number;
  lines: DiffLine[];
  rows: DiffPairRow[];
};

/** A single file's diff, parsed from a unified patch. */
export type ParsedDiffFile = {
  key: string;
  /** Path in the new revision, falling back to the old one on deletion. */
  path: string;
  /** Path in the old revision when it differs from `path`. */
  previousPath: string | null;
  changeType: DiffChangeType;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  /** Total rendered rows across every hunk, used to gate very large diffs. */
  lineCount: number;
  /** Widest line number in the file, used to size the gutter columns. */
  maxLineNumber: number;
};
