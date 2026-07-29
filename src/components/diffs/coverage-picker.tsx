"use client";

import { useLocale, useTranslations } from "next-intl";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateValue } from "@/lib/date-format";

import type { DiffCoverageReportOption } from "./types";

/**
 * Radix rejects an empty option value, so "no overlay" needs a sentinel. It is
 * not a legal report id, which keeps it unambiguous.
 */
export const NO_COVERAGE_REPORT = "none";

function percent(value: number | null): string | null {
  return value === null ? null : `${Math.round(value * 100)}%`;
}

/** Picks which coverage report, if any, is overlaid on the diff. */
export function CoveragePicker({
  loading,
  onSelect,
  reports,
  selectedId,
  stale,
}: {
  loading: boolean;
  onSelect: (reportId: string) => void;
  reports: DiffCoverageReportOption[];
  selectedId: string;
  stale: boolean;
}) {
  const t = useTranslations("diffs");
  const locale = useLocale();

  // Nothing to overlay: the picker would only offer "no overlay", so hide it.
  if (!reports.length) return null;

  const label = (report: DiffCoverageReportOption) => {
    const measured = formatDateValue(
      report.finishedAt ?? report.createdAt,
      "short",
      { locale },
    );
    const overall = percent(report.lineCoverage);
    const changed = percent(report.changedLineCoverage);
    const parts = [
      measured,
      overall && t("coverageOverall", { percent: overall }),
      changed && t("coverageChanged", { percent: changed }),
    ].filter(Boolean);
    return parts.join(" · ");
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Select onValueChange={onSelect} value={selectedId || NO_COVERAGE_REPORT}>
        <SelectTrigger aria-label={t("selectCoverageReport")} className="w-72">
          <SelectValue placeholder={t("noCoverageOverlay")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_COVERAGE_REPORT}>
            {t("noCoverageOverlay")}
          </SelectItem>
          {reports.map((report) => (
            <SelectItem key={report.id} value={report.id}>
              {label(report)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {loading ? (
        <p className="text-xs text-muted-foreground">{t("loadingCoverage")}</p>
      ) : stale ? (
        <p className="text-xs text-muted-foreground">{t("coverageStale")}</p>
      ) : null}
    </div>
  );
}
