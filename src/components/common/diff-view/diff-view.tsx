"use client";

import { Fragment, type ReactNode, useMemo, useState } from "react";
import { MessageSquarePlus } from "lucide-react";

import { cn } from "@/lib/utils";

import { parseUnifiedPatch } from "./parse-patch";
import type {
  DiffCoverageState,
  DiffHunk,
  DiffLine,
  DiffSide,
  DiffViewMode,
  LineCoverageLookup,
  ParsedDiffFile,
} from "./types";

/**
 * Above this many rows a file renders collapsed behind an opt-in button. A
 * diff this large is nearly always machine-generated, and mounting it costs
 * more than reading it is worth.
 */
const LARGE_DIFF_ROWS = 5000;

/** Approximate rendered row height, used to reserve space for skipped hunks. */
const ROW_HEIGHT_REM = 1.25;

export type DiffViewLabels = {
  /** Shown when the backend truncated the patch. */
  truncated: string;
  /** Shown in place of hunks for a binary file. */
  binary: string;
  /** Shown when the patch parsed to no hunks at all. */
  empty: string;
  /** Explains why a very large diff was held back, given its row count. */
  largeDiff: (count: number) => string;
  /** Button that mounts a diff held back by the large-diff guard. */
  renderAnyway: string;
  /** Accessible label for the per-line comment button. */
  addComment: string;
  /** Marks a line git reported without a trailing newline. */
  noNewline: string;
};

export type DiffViewProps = {
  file: ParsedDiffFile;
  mode: DiffViewMode;
  wrap: boolean;
  labels: DiffViewLabels;
  /** Resolves per-line coverage for the file's new revision. */
  coverage?: LineCoverageLookup;
  /** Dimmed when the report was measured at a different revision. */
  coverageStale?: boolean;
  /** Rendered full-width directly beneath a line — comment threads live here. */
  renderLineExtras?: (line: DiffLine, side: DiffSide) => ReactNode;
  /** Enables the hover affordance in the line-number gutter. */
  onLineAction?: (line: DiffLine, side: DiffSide) => void;
  /** Disables the hover affordance while keeping it visible. */
  lineActionDisabled?: boolean;
  /** Tooltip explaining why the affordance is disabled. */
  lineActionDisabledReason?: string;
  truncated?: boolean;
  className?: string;
};

/**
 * Width reserving `columns` monospace characters in a cell padded by `px-2`.
 *
 * The `1rem` is that padding, which `border-box` sizing folds into the width
 * rather than adding to it. The 1% is headroom: browsers round `1ch` a hair
 * below the font's real glyph advance — 7.219px against 7.227px for SF Mono at
 * this size — so an exact `Nch` reserve loses to the very text it is meant to
 * cover, and the column grows past it to fit.
 */
function reserveColumns(columns: number): string {
  const reserved = Number((columns * 1.01).toFixed(2));
  return `calc(${reserved}ch + 1rem)`;
}

function coverageClass(
  state: DiffCoverageState | null,
  stale: boolean,
): string | false {
  if (!state) return false;
  return cn(
    state === "covered" ? "bg-coverage-covered" : "bg-coverage-uncovered",
    stale && "opacity-40",
  );
}

/**
 * The coverage strip. It is always present so the grid column keeps a stable
 * width, and carries a title only when it has something to report.
 */
function CoverageCell({
  coverage,
  line,
  stale,
}: {
  coverage: LineCoverageLookup | undefined;
  line: DiffLine | null;
  stale: boolean;
}) {
  // Coverage is measured against the new revision, so deleted lines have none.
  const state = coverage && line?.newLine ? coverage(line.newLine) : null;
  return (
    <div
      aria-hidden
      className={cn("w-1 shrink-0", coverageClass(state, stale))}
      data-coverage={state ?? undefined}
    />
  );
}

function LineNumberCell({
  line,
  numberWidth,
  onAction,
  actionDisabled,
  actionDisabledReason,
  actionLabel,
  side,
  value,
}: {
  line: DiffLine | null;
  numberWidth: number;
  onAction?: (line: DiffLine, side: DiffSide) => void;
  actionDisabled?: boolean;
  actionDisabledReason?: string;
  actionLabel: string;
  side: DiffSide;
  value: number | null;
}) {
  const actionable = Boolean(onAction && line);
  return (
    <div
      className={cn(
        "group/line relative shrink-0 px-2 text-right tabular-nums select-none",
        "text-muted-foreground/70",
        line?.kind === "add" && "bg-diff-add-gutter",
        line?.kind === "delete" && "bg-diff-delete-gutter",
      )}
      // Sized from the file's widest line number, not this hunk's, so a hunk
      // numbered in the thousands doesn't get a wider gutter than one in the
      // tens.
      style={{ minWidth: reserveColumns(numberWidth) }}
    >
      {actionable && (
        <button
          aria-label={actionLabel}
          className={cn(
            "absolute top-1/2 left-0 hidden -translate-y-1/2 rounded-sm p-0.5",
            "text-muted-foreground hover:bg-accent hover:text-foreground",
            "group-hover/line:block focus-visible:block",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          disabled={actionDisabled}
          onClick={() => line && onAction?.(line, side)}
          title={actionDisabled ? actionDisabledReason : actionLabel}
          type="button"
        >
          <MessageSquarePlus className="size-3" />
        </button>
      )}
      {value ?? ""}
    </div>
  );
}

function ContentCell({
  line,
  marker,
  noNewlineLabel,
  wrap,
}: {
  line: DiffLine | null;
  marker: boolean;
  noNewlineLabel: string;
  wrap: boolean;
}) {
  return (
    <div
      className={cn(
        "px-2",
        wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
        line?.kind === "add" && "bg-diff-add text-diff-add-foreground",
        line?.kind === "delete" && "bg-diff-delete text-diff-delete-foreground",
        !line && "bg-muted/40",
      )}
    >
      {line && marker && (
        <span aria-hidden className="select-none">
          {line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}
        </span>
      )}
      {line?.content}
      {line?.noNewline && (
        <span className="ml-2 text-muted-foreground italic">
          {noNewlineLabel}
        </span>
      )}
    </div>
  );
}

/**
 * A zero-height row that reserves the file's widest line in every content
 * column.
 *
 * Each hunk is its own grid so it can be skipped while off screen, which also
 * means each one sizes its content columns to its own longest line — without
 * wrapping, hunks then end at different widths and split mode's divider lands
 * at a different x in each. Giving every grid the same minimum contribution
 * settles them all on the same column widths, with no measurement in JS.
 *
 * The width is reserved with `ch` rather than a hidden copy of the line, so
 * nothing here can turn up in a text selection or a find-in-page.
 */
function ColumnSizerRow({
  mode,
  maxLineWidth,
}: {
  mode: DiffViewMode;
  maxLineWidth: number;
}) {
  // Unified mode prefixes each line with a +/-/space marker; split mode doesn't.
  const columns = maxLineWidth + (mode === "SPLIT" ? 0 : 1);
  const content = (key: string) => (
    <div
      aria-hidden
      className="h-0"
      key={key}
      style={{ minWidth: reserveColumns(columns) }}
    />
  );
  // Empty cells hold the gutter columns' place so auto-placement stays honest;
  // they add no width of their own.
  const spacer = (key: string) => <div aria-hidden className="h-0" key={key} />;
  return mode === "SPLIT" ? (
    <>
      {spacer("left-number")}
      {content("left-content")}
      {spacer("coverage")}
      {spacer("right-number")}
      {content("right-content")}
    </>
  ) : (
    <>
      {spacer("coverage")}
      {spacer("old-number")}
      {spacer("new-number")}
      {content("content")}
    </>
  );
}

function HunkHeader({ header, span }: { header: string; span: string }) {
  return (
    <div
      className={cn(
        "bg-diff-hunk px-2 text-diff-hunk-foreground select-none",
        span,
      )}
    >
      {header}
    </div>
  );
}

function UnifiedHunk({
  hunk,
  props,
  numberWidth,
}: {
  hunk: DiffHunk;
  props: DiffViewProps;
  numberWidth: number;
}) {
  const {
    coverage,
    coverageStale = false,
    labels,
    lineActionDisabled,
    lineActionDisabledReason,
    onLineAction,
    renderLineExtras,
    wrap,
  } = props;
  return (
    <>
      <HunkHeader header={hunk.header} span="col-span-4" />
      {hunk.lines.map((line) => {
        // Deleted lines only exist on the old side, so their comment anchor
        // has to live in the old-number cell — the new-number cell is empty.
        const side: DiffSide = line.kind === "delete" ? "LEFT" : "RIGHT";
        const extras = renderLineExtras?.(line, side);
        return (
          <Fragment key={line.key}>
            <CoverageCell
              coverage={coverage}
              line={line}
              stale={coverageStale}
            />
            <LineNumberCell
              actionDisabled={lineActionDisabled}
              actionDisabledReason={lineActionDisabledReason}
              actionLabel={labels.addComment}
              line={line}
              numberWidth={numberWidth}
              onAction={side === "LEFT" ? onLineAction : undefined}
              side={side}
              value={line.oldLine}
            />
            <LineNumberCell
              actionDisabled={lineActionDisabled}
              actionDisabledReason={lineActionDisabledReason}
              actionLabel={labels.addComment}
              line={line}
              numberWidth={numberWidth}
              onAction={side === "RIGHT" ? onLineAction : undefined}
              side={side}
              value={line.newLine}
            />
            <ContentCell
              line={line}
              marker
              noNewlineLabel={labels.noNewline}
              wrap={wrap}
            />
            {extras && <div className="col-span-4">{extras}</div>}
          </Fragment>
        );
      })}
    </>
  );
}

function SplitHunk({
  hunk,
  props,
  numberWidth,
}: {
  hunk: DiffHunk;
  props: DiffViewProps;
  numberWidth: number;
}) {
  const {
    coverage,
    coverageStale = false,
    labels,
    lineActionDisabled,
    lineActionDisabledReason,
    onLineAction,
    renderLineExtras,
    wrap,
  } = props;
  return (
    <>
      <HunkHeader header={hunk.header} span="col-span-5" />
      {hunk.rows.map((row) => {
        // A context line occupies both sides; only anchor extras to it once.
        const extras =
          (row.right && renderLineExtras?.(row.right, "RIGHT")) ||
          (row.left && row.left !== row.right
            ? renderLineExtras?.(row.left, "LEFT")
            : null);
        return (
          <Fragment key={row.key}>
            <LineNumberCell
              actionDisabled={lineActionDisabled}
              actionDisabledReason={lineActionDisabledReason}
              actionLabel={labels.addComment}
              line={row.left}
              numberWidth={numberWidth}
              onAction={row.left && !row.right ? onLineAction : undefined}
              side="LEFT"
              value={row.left?.oldLine ?? null}
            />
            <ContentCell
              line={row.left}
              marker={false}
              noNewlineLabel={labels.noNewline}
              wrap={wrap}
            />
            <CoverageCell
              coverage={coverage}
              line={row.right}
              stale={coverageStale}
            />
            <LineNumberCell
              actionDisabled={lineActionDisabled}
              actionDisabledReason={lineActionDisabledReason}
              actionLabel={labels.addComment}
              line={row.right}
              numberWidth={numberWidth}
              onAction={onLineAction}
              side="RIGHT"
              value={row.right?.newLine ?? null}
            />
            <ContentCell
              line={row.right}
              marker={false}
              noNewlineLabel={labels.noNewline}
              wrap={wrap}
            />
            {extras && <div className="col-span-5">{extras}</div>}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * Renders one file's diff, either interleaved or side by side.
 *
 * Both modes project the same parsed model, and both use a single CSS grid per
 * hunk. The shared grid is what lets split mode survive wrapping: a wrapped
 * line makes its grid row taller, so the two sides stay aligned without any
 * measurement in JS.
 */
export function DiffView(props: DiffViewProps) {
  const { className, file, labels, mode, truncated = false, wrap } = props;
  const [forceRender, setForceRender] = useState(false);
  const numberWidth = useMemo(
    () => Math.max(2, String(file.maxLineNumber).length),
    [file.maxLineNumber],
  );

  const oversized = file.lineCount > LARGE_DIFF_ROWS && !forceRender;
  const columns =
    mode === "SPLIT"
      ? "grid-cols-[auto_minmax(0,1fr)_auto_auto_minmax(0,1fr)]"
      : "grid-cols-[auto_auto_auto_minmax(0,1fr)]";

  const body = () => {
    if (file.binary) {
      return <p className="p-3 text-muted-foreground">{labels.binary}</p>;
    }
    if (!file.hunks.length) {
      return <p className="p-3 text-muted-foreground">{labels.empty}</p>;
    }
    if (oversized) {
      return (
        <div className="flex flex-col items-start gap-2 p-3">
          <p className="text-muted-foreground">
            {labels.largeDiff(file.lineCount)}
          </p>
          <button
            className="rounded-md border px-2 py-1 hover:bg-accent"
            onClick={() => setForceRender(true)}
            type="button"
          >
            {labels.renderAnyway}
          </button>
        </div>
      );
    }
    return file.hunks.map((hunk) => (
      <div
        className={cn(
          "grid [content-visibility:auto]",
          columns,
          // Without wrap the grid must exceed the viewport so row backgrounds
          // span the full line rather than stopping at the scroll edge.
          wrap ? "w-full" : "w-max min-w-full",
        )}
        key={hunk.key}
        style={{
          containIntrinsicSize: `auto ${(hunk.lines.length + 1) * ROW_HEIGHT_REM}rem`,
        }}
      >
        {/* Wrapped columns are all 1fr of the container, so they need no help. */}
        {!wrap && (
          <ColumnSizerRow maxLineWidth={file.maxLineWidth} mode={mode} />
        )}
        {mode === "SPLIT" ? (
          <SplitHunk hunk={hunk} numberWidth={numberWidth} props={props} />
        ) : (
          <UnifiedHunk hunk={hunk} numberWidth={numberWidth} props={props} />
        )}
      </div>
    ));
  };

  return (
    <div
      className={cn(
        "overflow-x-auto rounded-md border bg-card font-mono text-xs leading-5",
        className,
      )}
    >
      {body()}
      {truncated && (
        <p className="border-t p-2 text-muted-foreground">{labels.truncated}</p>
      )}
    </div>
  );
}

/**
 * `DiffView` for callers holding raw patch text for a single file. A patch
 * describing several files renders only the first; use `MultiFileDiffView` for
 * whole-patch blobs.
 */
export function PatchDiffView({
  patch,
  ...props
}: { patch: string } & Omit<DiffViewProps, "file">) {
  const file = useMemo(() => parseUnifiedPatch(patch)[0] ?? null, [patch]);
  if (!file) {
    return (
      <div
        className={cn(
          "rounded-md border bg-card p-3 font-mono text-xs text-muted-foreground",
          props.className,
        )}
      >
        {props.labels.empty}
      </div>
    );
  }
  return <DiffView file={file} {...props} />;
}
