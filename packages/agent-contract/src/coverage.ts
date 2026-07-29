/**
 * Importing a coverage file a test runner wrote into the same report shape the
 * Xcode pipeline produces (see `handlers/builds.ts` → `normalizeCoverage`).
 *
 * The parsing lives here rather than in the agent so the app's test suite runs
 * it: `vitest.config.mts` excludes `packages/control-agent/**` but not this
 * package. The agent handler is left with reading the file, asking git which
 * lines the branch changed, and calling the two functions below.
 */

import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const COVERAGE_IMPORT_JOB_KIND = "coverage.import";
export const COVERAGE_JOB_KINDS = [COVERAGE_IMPORT_JOB_KIND] as const;

/**
 * `AUTO` sniffs the file: LCOV is a line-oriented text format and Istanbul's
 * `coverage-final.json` is JSON, so they are never ambiguous.
 */
export const COVERAGE_REPORT_FORMATS = ["AUTO", "LCOV", "ISTANBUL"] as const;
export type CoverageReportFormat = (typeof COVERAGE_REPORT_FORMATS)[number];

export type CoverageImportPayload = {
  buildId: string;
  codebaseId: string;
  worktreeId: string;
  /** Absolute path of the worktree the report describes. */
  folder: string;
  /** The coverage file, relative to `folder`. */
  reportPath: string;
  format: CoverageReportFormat;
  /**
   * Branch the changed-line numbers are measured against. Null skips the
   * changed-file half of the report, which leaves the whole-file coverage
   * intact but gives the diff viewer nothing to overlay.
   */
  baseBranch: string | null;
};

/** One file's executable lines, split by whether the run reached them. */
export type CoverageFileLines = {
  /** Path exactly as the report wrote it — absolute or worktree-relative. */
  path: string;
  coveredLineNumbers: number[];
  uncoveredLineNumbers: number[];
};

/** A file the branch touched, with the line numbers the diff added or changed. */
export type CoverageChangedFile = {
  path: string;
  changeType: string;
  lines: number[];
};

export type CoverageReportPayload = {
  summary: Record<string, unknown>;
  data: Record<string, unknown>;
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, name: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.length || value.length > maximum) {
    throw new Error(
      `${name} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return value;
}

export function parseCoverageImportPayload(
  value: unknown,
): CoverageImportPayload {
  const payload = objectValue(value, "coverage import payload");
  const format = stringValue(payload.format ?? "AUTO", "format", 20);
  if (!(COVERAGE_REPORT_FORMATS as readonly string[]).includes(format)) {
    throw new Error("format must be AUTO, LCOV, or ISTANBUL");
  }
  const reportPath = stringValue(payload.reportPath, "reportPath", 4_000);
  if (isAbsolute(reportPath) || reportPath.split(/[\\/]/).includes("..")) {
    throw new Error("reportPath must stay inside the worktree");
  }
  return {
    buildId: stringValue(payload.buildId, "buildId", 200),
    codebaseId: stringValue(payload.codebaseId, "codebaseId", 200),
    worktreeId: stringValue(payload.worktreeId, "worktreeId", 200),
    folder: stringValue(payload.folder, "folder", 4_000),
    reportPath,
    format: format as CoverageReportFormat,
    baseBranch:
      payload.baseBranch === null || payload.baseBranch === undefined
        ? null
        : stringValue(payload.baseBranch, "baseBranch", 500),
  };
}

/**
 * Tells the two supported formats apart. Istanbul writes a JSON object, LCOV
 * writes records that always start with a two-letter tag, so the first
 * non-blank character decides it.
 */
export function detectCoverageFormat(contents: string): "LCOV" | "ISTANBUL" {
  return contents.trimStart().startsWith("{") ? "ISTANBUL" : "LCOV";
}

/**
 * Reads the `SF`/`DA` records of an LCOV file.
 *
 * `DA:<line>,<hits>` is the only record that carries line numbers; `LF`/`LH`
 * are totals this report recomputes anyway. Branch records are ignored — the
 * coverage viewer paints lines.
 */
export function parseLcovReport(contents: string): CoverageFileLines[] {
  const files: CoverageFileLines[] = [];
  let path: string | null = null;
  let covered = new Set<number>();
  let uncovered = new Set<number>();
  const flush = () => {
    if (path) {
      files.push({
        path,
        coveredLineNumbers: [...covered].sort((a, b) => a - b),
        uncoveredLineNumbers: [...uncovered].sort((a, b) => a - b),
      });
    }
    path = null;
    covered = new Set();
    uncovered = new Set();
  };
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      flush();
      path = line.slice(3).trim();
      continue;
    }
    if (line === "end_of_record") {
      flush();
      continue;
    }
    if (!path || !line.startsWith("DA:")) continue;
    const [rawNumber, rawHits] = line.slice(3).split(",");
    const number = Number(rawNumber);
    if (!Number.isInteger(number) || number <= 0) continue;
    // A line can appear more than once when several records map to it; any hit
    // makes it covered, so promote rather than overwrite.
    if (Number(rawHits) > 0) {
      covered.add(number);
      uncovered.delete(number);
    } else if (!covered.has(number)) {
      uncovered.add(number);
    }
  }
  flush();
  return files;
}

/**
 * Reads Istanbul's `coverage-final.json`, the shape `vitest --coverage` and
 * `nyc` both emit.
 *
 * A statement is attributed to the line it starts on, which is how Istanbul's
 * own LCOV writer counts lines, and a line counts as covered when any statement
 * starting there ran.
 */
export function parseIstanbulReport(contents: string): CoverageFileLines[] {
  const root = objectValue(JSON.parse(contents), "istanbul coverage");
  const files: CoverageFileLines[] = [];
  for (const [key, rawEntry] of Object.entries(root)) {
    const entry = objectValue(rawEntry, `istanbul coverage["${key}"]`);
    const statements = objectValue(
      entry.statementMap ?? {},
      `istanbul coverage["${key}"].statementMap`,
    );
    const counts = objectValue(entry.s ?? {}, `istanbul coverage["${key}"].s`);
    const covered = new Set<number>();
    const uncovered = new Set<number>();
    for (const [id, rawStatement] of Object.entries(statements)) {
      const statement = objectValue(rawStatement, "istanbul statement");
      const start = objectValue(statement.start ?? {}, "istanbul statement");
      const line = start.line;
      if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) {
        continue;
      }
      if (Number(counts[id] ?? 0) > 0) {
        covered.add(line);
        uncovered.delete(line);
      } else if (!covered.has(line)) {
        uncovered.add(line);
      }
    }
    files.push({
      path: typeof entry.path === "string" ? entry.path : key,
      coveredLineNumbers: [...covered].sort((a, b) => a - b),
      uncoveredLineNumbers: [...uncovered].sort((a, b) => a - b),
    });
  }
  return files;
}

export function parseCoverageReport(
  contents: string,
  format: CoverageReportFormat,
): CoverageFileLines[] {
  const resolved = format === "AUTO" ? detectCoverageFormat(contents) : format;
  return resolved === "ISTANBUL"
    ? parseIstanbulReport(contents)
    : parseLcovReport(contents);
}

/** Forward-slash path relative to the worktree, or null when it escapes it. */
function worktreePath(path: string, folder: string): string | null {
  const absolute = isAbsolute(path) ? path : resolve(folder, path);
  const difference = relative(folder, absolute).split(sep).join("/");
  if (!difference || difference === ".." || difference.startsWith("../")) {
    return null;
  }
  return difference;
}

const ratio = (covered: number, executable: number): number =>
  executable === 0 ? 0 : covered / executable;

/**
 * Turns parsed line data plus the branch's changed lines into the report the
 * coverage pages read.
 *
 * `data.files` keeps absolute paths because that is what an `xccov` export
 * records and what `relativeCoveragePath` on the client expects; `changedFiles`
 * stays worktree-relative, matching the diff viewer's own paths. Files the
 * report mentions from outside the worktree are dropped rather than kept as
 * unmatchable absolute rows.
 *
 * The target column groups by the first path segment — `src`, `packages`,
 * `scripts` — which is the closest thing a JavaScript project has to the Xcode
 * target the column was built for.
 */
export function buildCoverageReportPayload(input: {
  files: CoverageFileLines[];
  folder: string;
  changes: CoverageChangedFile[];
}): CoverageReportPayload {
  const byPath = new Map<string, CoverageFileLines>();
  const files: Array<Record<string, unknown>> = [];
  const targets = new Set<string>();
  let coveredLines = 0;
  let executableLines = 0;
  for (const file of input.files) {
    const path = worktreePath(file.path, input.folder);
    if (!path) continue;
    byPath.set(path, file);
    const covered = file.coveredLineNumbers.length;
    const executable = covered + file.uncoveredLineNumbers.length;
    coveredLines += covered;
    executableLines += executable;
    const segments = path.split("/");
    const target = segments.length > 1 ? segments[0]! : "";
    targets.add(target);
    files.push({
      target,
      name: basename(path),
      path: resolve(input.folder, path),
      coveredLines: covered,
      executableLines: executable,
      lineCoverage: ratio(covered, executable),
    });
  }
  const changedFiles: Array<Record<string, unknown>> = [];
  let changedCoveredLines = 0;
  let changedExecutableLines = 0;
  for (const change of input.changes) {
    const file = byPath.get(change.path);
    const changed = new Set(change.lines);
    const changedCovered = (file?.coveredLineNumbers ?? []).filter((line) =>
      changed.has(line),
    ).length;
    const changedExecutable =
      changedCovered +
      (file?.uncoveredLineNumbers ?? []).filter((line) => changed.has(line))
        .length;
    changedCoveredLines += changedCovered;
    changedExecutableLines += changedExecutable;
    changedFiles.push({
      path: change.path,
      changeType: change.changeType,
      changedCoveredLines: changedCovered,
      changedExecutableLines: changedExecutable,
      changedLineCoverage: changedExecutable
        ? ratio(changedCovered, changedExecutable)
        : null,
      coveredLineNumbers: file?.coveredLineNumbers ?? [],
      uncoveredLineNumbers: file?.uncoveredLineNumbers ?? [],
    });
  }
  return {
    summary: {
      coveredLines,
      executableLines,
      lineCoverage: ratio(coveredLines, executableLines),
      targetCount: targets.size,
      fileCount: files.length,
      changedCoveredLines,
      changedExecutableLines,
      changedLineCoverage: changedExecutableLines
        ? ratio(changedCoveredLines, changedExecutableLines)
        : null,
    },
    data: { files, changedFiles },
  };
}
