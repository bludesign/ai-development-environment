"use client";

import { useEffect, useState } from "react";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import { relativeCoveragePath } from "@/lib/coverage-paths";

import {
  DIFF_COVERAGE_REPORTS_QUERY,
  DIFF_COVERAGE_REPORT_QUERY,
} from "./diffs-graphql";
import type { DiffCoverageFile, DiffCoverageReportOption } from "./types";

/**
 * Shared empty results, so a worktree without coverage hands back the same
 * identity every render and the page's derivations stay memoized.
 */
const NO_REPORTS: DiffCoverageReportOption[] = [];
const NO_FILES = new Map<string, DiffCoverageFile>();

type ReportsResponse = {
  worktreeCoverageReports: Array<{
    id: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
    coverageSummary: {
      lineCoverage: number | null;
      changedLineCoverage: number | null;
    } | null;
    build: { id: string; snapshot: unknown } | null;
  }>;
};

type ReportResponse = {
  build: {
    reports: Array<{
      id: string;
      kind: string;
      status: string;
      coverageFiles: Array<{
        target: string;
        path: string;
        lineCoverage: number;
      }>;
      changedCoverageFiles: Array<{
        path: string;
        coveredLineNumbers: number[];
        uncoveredLineNumbers: number[];
      }>;
    }>;
  } | null;
};

/** Digs the measured revision out of the build snapshot's loose JSON. */
function snapshotHeadSha(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const worktree = (snapshot as Record<string, unknown>).worktree;
  if (!worktree || typeof worktree !== "object") return null;
  const headSha = (worktree as Record<string, unknown>).headSha;
  return typeof headSha === "string" ? headSha : null;
}

/**
 * Lists the worktree's coverage reports for the picker.
 *
 * Only `READY` reports are offered: a pending or failed one has no file data
 * behind it, so selecting it could only ever produce an empty overlay.
 *
 * Results are tagged with the worktree they describe and discarded by
 * derivation, so switching worktrees never shows the previous one's reports and
 * the effect never sets state synchronously.
 */
export function useCoverageReports(worktreeId: string) {
  const [loaded, setLoaded] = useState<{
    worktreeId: string;
    reports: DiffCoverageReportOption[];
  } | null>(null);

  useEffect(() => {
    if (!worktreeId) return;
    let disposed = false;
    void controlPlaneRequest<ReportsResponse>(DIFF_COVERAGE_REPORTS_QUERY, {
      worktreeId,
    })
      .then((data) => {
        if (disposed) return;
        setLoaded({
          worktreeId,
          reports: data.worktreeCoverageReports
            .filter((report) => report.status === "READY" && report.build)
            .map((report) => ({
              id: report.id,
              buildId: report.build!.id,
              status: report.status,
              createdAt: report.createdAt,
              finishedAt: report.finishedAt,
              lineCoverage: report.coverageSummary?.lineCoverage ?? null,
              changedLineCoverage:
                report.coverageSummary?.changedLineCoverage ?? null,
              headSha: snapshotHeadSha(report.build!.snapshot),
            })),
        });
      })
      // A worktree with no builds is the common case, not an error worth
      // pushing into the page's error banner.
      .catch(() => {
        if (!disposed) setLoaded({ worktreeId, reports: NO_REPORTS });
      });
    return () => {
      disposed = true;
    };
  }, [worktreeId]);

  return loaded?.worktreeId === worktreeId ? loaded.reports : NO_REPORTS;
}

/**
 * Loads the selected report and indexes it by worktree-relative path.
 *
 * Whole-file coverage and the owning target come from the report's full file
 * list; the per-line numbers only exist for files the branch changed, which is
 * exactly the set this page can show a diff for.
 */
export function useCoverageReport(
  report: DiffCoverageReportOption | null,
  worktreeFolder: string | null,
) {
  const [loaded, setLoaded] = useState<{
    reportId: string;
    files: Map<string, DiffCoverageFile>;
  } | null>(null);
  const [failedReportId, setFailedReportId] = useState("");
  // The caller re-derives the report object every render, so the effect keys off
  // the identifiers rather than the object identity.
  const reportId = report?.id ?? "";
  const buildId = report?.buildId ?? "";

  useEffect(() => {
    if (!reportId || !buildId) return;
    let disposed = false;
    void controlPlaneRequest<ReportResponse>(DIFF_COVERAGE_REPORT_QUERY, {
      buildId,
    })
      .then((data) => {
        if (disposed) return;
        const match = data.build?.reports.find(
          (candidate) => candidate.id === reportId,
        );
        const files = new Map<string, DiffCoverageFile>();
        for (const file of match?.coverageFiles ?? []) {
          files.set(relativeCoveragePath(file.path, worktreeFolder), {
            lineCoverage: file.lineCoverage,
            module: file.target || null,
            covered: new Set(),
            uncovered: new Set(),
          });
        }
        for (const file of match?.changedCoverageFiles ?? []) {
          // Changed-file paths are recorded worktree-relative already.
          const existing = files.get(file.path);
          files.set(file.path, {
            lineCoverage: existing?.lineCoverage ?? null,
            module: existing?.module ?? null,
            covered: new Set(file.coveredLineNumbers),
            uncovered: new Set(file.uncoveredLineNumbers),
          });
        }
        setLoaded({ reportId, files });
      })
      .catch(() => {
        if (!disposed) setFailedReportId(reportId);
      });
    return () => {
      disposed = true;
    };
  }, [buildId, reportId, worktreeFolder]);

  // Derived rather than cleared from an effect, so switching reports never
  // renders the previous one's numbers against the new selection.
  const files = loaded?.reportId === reportId ? loaded.files : NO_FILES;
  const loading =
    Boolean(reportId) &&
    loaded?.reportId !== reportId &&
    failedReportId !== reportId;

  return { files, loading };
}
