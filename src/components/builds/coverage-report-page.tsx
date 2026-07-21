"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Search,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { BuildReport } from "./types";

type CoverageFile = {
  target: string;
  name: string;
  path: string;
  coveredLines: number;
  executableLines: number;
  lineCoverage: number;
};

type ChangedCoverageFile = {
  path: string;
  changedCoveredLines: number;
  changedExecutableLines: number;
  changedLineCoverage: number | null;
  changeType?: string;
};

type DisplayChangedCoverageFile = ChangedCoverageFile & {
  displayName: string;
  displayPath: string;
};

type CoverageSortKey =
  "filename" | "target" | "lineCoverage" | "uncoveredLines";
type CoverageSort = {
  key: CoverageSortKey;
  direction: "asc" | "desc";
};

type ChangedCoverageSortKey =
  "filename" | "changeType" | "coveredLines" | "lineCoverage";
type ChangedCoverageSort = {
  key: ChangedCoverageSortKey;
  direction: "asc" | "desc";
};

function uncoveredLines(file: CoverageFile): number {
  return Math.max(0, file.executableLines - file.coveredLines);
}

function relativeCoveragePath(path: string, worktreeFolder: string | null) {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRoot = worktreeFolder
    ?.replaceAll("\\", "/")
    .replace(/\/$/, "");
  if (!normalizedRoot) return normalizedPath;
  if (normalizedPath === normalizedRoot) return ".";
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}

function coverageFileName(path: string) {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

export function CoverageReportPage({ buildId }: { buildId: string }) {
  const t = useTranslations("builds");
  const locale = useLocale();
  const [report, setReport] = useState<BuildReport | null>(null);
  const [buildName, setBuildName] = useState(buildId);
  const [worktreeFolder, setWorktreeFolder] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [allFilesOpen, setAllFilesOpen] = useState(false);
  const [sort, setSort] = useState<CoverageSort>({
    key: "filename",
    direction: "asc",
  });
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        build: {
          id: string;
          snapshot: Record<string, unknown>;
          reports: BuildReport[];
        } | null;
      }>(
        `query CoverageReport($id: ID!) {
          build(id: $id) {
            id snapshot
            reports {
              id kind source status summary data error createdAt updatedAt finishedAt
              artifact { id kind relativePath sizeBytes checksum metadata createdAt }
            }
          }
        }`,
        { id: buildId },
      );
      const coverage = data.build?.reports.find(
        (candidate) => candidate.kind === "CODE_COVERAGE",
      );
      setReport(coverage ?? null);
      const configuration = data.build?.snapshot.configuration as
        { name?: string } | undefined;
      const worktree = data.build?.snapshot.worktree as
        { folder?: string } | undefined;
      setBuildName(configuration?.name ?? buildId);
      setWorktreeFolder(worktree?.folder ?? null);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [buildId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const rawFiles = useMemo(
    () =>
      Array.isArray(report?.data.files)
        ? (report.data.files as CoverageFile[])
        : [],
    [report],
  );
  const files = useMemo(() => {
    const filtered = rawFiles.filter((file) =>
      `${file.target} ${file.name} ${relativeCoveragePath(file.path, worktreeFolder)}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
    );
    const stringCompare = (left: string, right: string) =>
      left.localeCompare(right, locale, { numeric: true, sensitivity: "base" });
    return filtered.toSorted((left, right) => {
      let comparison = 0;
      if (sort.key === "filename") {
        comparison = stringCompare(left.name, right.name);
      } else if (sort.key === "target") {
        comparison = stringCompare(left.target, right.target);
      } else if (sort.key === "lineCoverage") {
        comparison = left.lineCoverage - right.lineCoverage;
      } else {
        comparison = uncoveredLines(left) - uncoveredLines(right);
      }
      if (comparison !== 0) {
        return sort.direction === "asc" ? comparison : -comparison;
      }
      return (
        stringCompare(left.name, right.name) ||
        stringCompare(left.target, right.target) ||
        stringCompare(left.path, right.path)
      );
    });
  }, [locale, rawFiles, search, sort, worktreeFolder]);
  const changedFiles = Array.isArray(report?.data.changedFiles)
    ? (report.data.changedFiles as ChangedCoverageFile[])
    : [];
  const percent = (value: unknown) =>
    typeof value === "number"
      ? new Intl.NumberFormat(locale, {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(value)
      : "—";
  const selectSort = (key: CoverageSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : {
            key,
            direction:
              key === "lineCoverage" || key === "uncoveredLines"
                ? "desc"
                : "asc",
          },
    );
  };

  if (loading) {
    return (
      <p className="mx-auto flex max-w-6xl items-center gap-2 text-muted-foreground">
        <Spinner /> {t("loadingCoverageReport")}
      </p>
    );
  }
  if (!report) {
    return (
      <Empty className="mx-auto max-w-6xl border py-12">
        <EmptyHeader>
          <EmptyTitle>{t("coverageReportNotFound")}</EmptyTitle>
          <EmptyDescription>
            {t("coverageReportNotFoundDescription")}
          </EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link href={`/builds/${buildId}`}>
            <ArrowLeft /> {t("backToBuild")}
          </Link>
        </Button>
      </Empty>
    );
  }
  return (
    <section className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div>
        <Button asChild className="-ml-2" size="sm" variant="ghost">
          <Link href={`/builds/${buildId}`}>
            <ArrowLeft /> {t("backToBuild")}
          </Link>
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {report.error && (
        <Alert variant="destructive">
          <AlertDescription>{report.error}</AlertDescription>
        </Alert>
      )}
      <div>
        <p className="text-sm text-muted-foreground">{t("coverageReport")}</p>
        <h1 className="text-2xl font-semibold">{buildName}</h1>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label={t("overallCoverage")}
          percentage={report.summary.lineCoverage}
          value={percent(report.summary.lineCoverage)}
        />
        <Metric
          label={t("coveredLines")}
          value={String(report.summary.coveredLines ?? 0)}
        />
        <Metric
          label={t("executableLines")}
          value={String(report.summary.executableLines ?? 0)}
        />
        <Metric
          label={t("changedCoverage")}
          percentage={report.summary.changedLineCoverage}
          value={percent(report.summary.changedLineCoverage)}
        />
      </div>
      {changedFiles.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("changedFilesCoverage")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CoverageChangedTable
              coverageFiles={rawFiles}
              files={changedFiles}
              percent={percent}
              worktreeFolder={worktreeFolder}
            />
          </CardContent>
        </Card>
      )}
      <Card className="gap-0 py-0">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <Button
              aria-expanded={allFilesOpen}
              className="-m-2 h-auto min-w-0 flex-1 justify-start p-2 text-left aria-expanded:bg-transparent aria-expanded:hover:bg-muted dark:aria-expanded:bg-transparent dark:aria-expanded:hover:bg-muted/50"
              onClick={() => setAllFilesOpen((current) => !current)}
              type="button"
              variant="ghost"
            >
              <span className="truncate font-medium">
                {t("allCoverageFiles")}
              </span>
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Badge>{rawFiles.length}</Badge>
              <Button
                aria-expanded={allFilesOpen}
                aria-label={t(
                  allFilesOpen
                    ? "collapseCoverageFiles"
                    : "expandCoverageFiles",
                )}
                onClick={() => setAllFilesOpen((current) => !current)}
                size="icon-sm"
                title={t(
                  allFilesOpen
                    ? "collapseCoverageFiles"
                    : "expandCoverageFiles",
                )}
                type="button"
                variant="ghost"
              >
                {allFilesOpen ? (
                  <ChevronDown className="size-5" />
                ) : (
                  <ChevronRight className="size-5" />
                )}
              </Button>
            </div>
          </div>
        </CardHeader>
        {allFilesOpen && (
          <CardContent className="space-y-4 py-4">
            <div className="relative max-w-xl">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={t("searchCoverageFiles")}
                className="pl-9"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchCoverageFiles")}
                value={search}
              />
            </div>
            <div className="overflow-auto rounded-md border">
              <Table
                aria-label={t("allCoverageFiles")}
                className="min-w-[60rem] text-xs"
              >
                <TableHeader>
                  <TableRow>
                    <SortableCoverageHead
                      activeSort={sort}
                      ariaLabel={t("sortCoverageFiles", {
                        column: t("coverageTarget"),
                      })}
                      label={t("coverageTarget")}
                      onSort={selectSort}
                      sortKey="target"
                    />
                    <SortableCoverageHead
                      activeSort={sort}
                      ariaLabel={t("sortCoverageFiles", {
                        column: t("coverageFile"),
                      })}
                      label={t("coverageFile")}
                      onSort={selectSort}
                      sortKey="filename"
                    />
                    <TableHead className="h-8 px-2 text-right">
                      {t("coveredLines")}
                    </TableHead>
                    <SortableCoverageHead
                      activeSort={sort}
                      align="right"
                      ariaLabel={t("sortCoverageFiles", {
                        column: t("uncoveredLines"),
                      })}
                      label={t("uncoveredLines")}
                      onSort={selectSort}
                      sortKey="uncoveredLines"
                    />
                    <SortableCoverageHead
                      activeSort={sort}
                      align="right"
                      ariaLabel={t("sortCoverageFiles", {
                        column: t("coverage"),
                      })}
                      label={t("coverage")}
                      onSort={selectSort}
                      sortKey="lineCoverage"
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {files.map((file, index) => (
                    <TableRow key={`${file.target}:${file.path}:${index}`}>
                      <TableCell className="px-2 py-1.5">
                        <Badge variant="outline">{file.target}</Badge>
                      </TableCell>
                      <TableCell className="max-w-xl px-2 py-1.5">
                        <div className="flex min-w-0 items-baseline gap-2">
                          <span className="shrink-0 font-medium">
                            {file.name}
                          </span>
                          <span
                            className="min-w-0 truncate font-mono text-muted-foreground"
                            title={file.path}
                          >
                            {relativeCoveragePath(file.path, worktreeFolder)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-right tabular-nums">
                        {file.coveredLines} / {file.executableLines}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-right tabular-nums">
                        {uncoveredLines(file)}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-right font-medium">
                        <CoverageValue
                          percent={percent}
                          value={file.lineCoverage}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        )}
      </Card>
    </section>
  );
}

function SortableCoverageHead({
  activeSort,
  align = "left",
  ariaLabel,
  label,
  onSort,
  sortKey,
}: {
  activeSort: CoverageSort;
  align?: "left" | "right";
  ariaLabel: string;
  label: string;
  onSort: (key: CoverageSortKey) => void;
  sortKey: CoverageSortKey;
}) {
  const active = activeSort.key === sortKey;
  return (
    <SortableTableHead
      active={active}
      align={align}
      ariaLabel={ariaLabel}
      direction={activeSort.direction}
      label={label}
      onSort={() => onSort(sortKey)}
    />
  );
}

function SortableTableHead({
  active,
  align,
  ariaLabel,
  direction,
  label,
  onSort,
}: {
  active: boolean;
  align: "left" | "right";
  ariaLabel: string;
  direction: "asc" | "desc";
  label: string;
  onSort: () => void;
}) {
  return (
    <TableHead
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
      className="h-8 px-2"
    >
      <Button
        aria-label={ariaLabel}
        className={`-mx-2 h-7 px-2 text-xs ${align === "right" ? "w-[calc(100%+1rem)] justify-end" : "justify-start"}`}
        onClick={onSort}
        size="sm"
        title={ariaLabel}
        type="button"
        variant="ghost"
      >
        {label}
        {active ? (
          direction === "asc" ? (
            <ArrowUp />
          ) : (
            <ArrowDown />
          )
        ) : (
          <ArrowUpDown />
        )}
      </Button>
    </TableHead>
  );
}

function CoverageValue({
  value,
  percent,
  size = "compact",
}: {
  value: number | null;
  percent: (value: unknown) => string;
  size?: "compact" | "metric";
}) {
  if (typeof value !== "number") return <>—</>;
  const normalized = Math.max(0, Math.min(1, value));
  const color =
    normalized >= 0.8
      ? "text-emerald-500"
      : normalized >= 0.5
        ? "text-amber-500"
        : "text-red-500";
  return (
    <span
      className={`inline-flex items-center justify-end tabular-nums ${size === "metric" ? "gap-2 text-2xl font-semibold" : "gap-1.5"}`}
    >
      {percent(value)}
      <span
        aria-hidden="true"
        className={`${size === "metric" ? "size-7" : "size-3.5"} shrink-0 rounded-full ring-1 ring-foreground/10 ${color}`}
        data-coverage-indicator
        style={{
          background: `conic-gradient(currentColor ${normalized * 360}deg, var(--muted) 0deg)`,
        }}
      />
    </span>
  );
}

function Metric({
  label,
  percentage,
  value,
}: {
  label: string;
  percentage?: unknown;
  value: string;
}) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-1">
          {typeof percentage === "number" ? (
            <CoverageValue
              percent={() => value}
              size="metric"
              value={percentage}
            />
          ) : (
            <p className="text-2xl font-semibold tabular-nums">{value}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CoverageChangedTable({
  coverageFiles,
  files,
  percent,
  worktreeFolder,
}: {
  coverageFiles: CoverageFile[];
  files: ChangedCoverageFile[];
  percent: (value: unknown) => string;
  worktreeFolder: string | null;
}) {
  const t = useTranslations("builds");
  const locale = useLocale();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ChangedCoverageSort>({
    key: "filename",
    direction: "asc",
  });
  const displayFiles: DisplayChangedCoverageFile[] = files.map((file) => {
    const displayPath = relativeCoveragePath(file.path, worktreeFolder);
    const matches = coverageFiles.filter(
      (coverageFile) =>
        relativeCoveragePath(coverageFile.path, worktreeFolder) === displayPath,
    );
    return {
      ...file,
      displayName: matches[0]?.name ?? coverageFileName(displayPath),
      displayPath,
    };
  });
  const sortedFiles = displayFiles
    .filter((file) =>
      `${file.displayName} ${file.displayPath} ${file.changeType ?? ""}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
    )
    .toSorted((left, right) => {
      const stringCompare = (leftValue: string, rightValue: string) =>
        leftValue.localeCompare(rightValue, locale, {
          numeric: true,
          sensitivity: "base",
        });
      let comparison = 0;
      if (sort.key === "filename") {
        comparison =
          stringCompare(left.displayName, right.displayName) ||
          stringCompare(left.displayPath, right.displayPath);
      } else if (sort.key === "changeType") {
        comparison = stringCompare(
          left.changeType ?? "",
          right.changeType ?? "",
        );
      } else if (sort.key === "coveredLines") {
        comparison = left.changedCoveredLines - right.changedCoveredLines;
      } else {
        comparison =
          (left.changedLineCoverage ?? -1) - (right.changedLineCoverage ?? -1);
      }
      if (comparison !== 0) {
        return sort.direction === "asc" ? comparison : -comparison;
      }
      return stringCompare(left.displayPath, right.displayPath);
    });
  const selectSort = (key: ChangedCoverageSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : {
            key,
            direction:
              key === "coveredLines" || key === "lineCoverage" ? "desc" : "asc",
          },
    );
  };
  return (
    <div className="space-y-4">
      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={t("searchChangedCoverageFiles")}
          className="pl-9"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("searchChangedCoverageFiles")}
          value={search}
        />
      </div>
      <div className="overflow-auto rounded-md border">
        <Table aria-label={t("changedFilesCoverage")} className="text-xs">
          <TableHeader>
            <TableRow>
              <SortableChangedCoverageHead
                activeSort={sort}
                ariaLabel={t("sortCoverageFiles", {
                  column: t("coverageFile"),
                })}
                label={t("coverageFile")}
                onSort={selectSort}
                sortKey="filename"
              />
              <SortableChangedCoverageHead
                activeSort={sort}
                ariaLabel={t("sortCoverageFiles", {
                  column: t("changeType"),
                })}
                label={t("changeType")}
                onSort={selectSort}
                sortKey="changeType"
              />
              <SortableChangedCoverageHead
                activeSort={sort}
                align="right"
                ariaLabel={t("sortCoverageFiles", {
                  column: t("coveredLines"),
                })}
                label={t("coveredLines")}
                onSort={selectSort}
                sortKey="coveredLines"
              />
              <SortableChangedCoverageHead
                activeSort={sort}
                align="right"
                ariaLabel={t("sortCoverageFiles", {
                  column: t("coverage"),
                })}
                label={t("coverage")}
                onSort={selectSort}
                sortKey="lineCoverage"
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedFiles.map((file) => (
              <TableRow key={file.path}>
                <TableCell className="max-w-xl px-2 py-1.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 font-medium">
                      {file.displayName}
                    </span>
                    <span
                      className="min-w-0 truncate font-mono text-muted-foreground"
                      title={file.path}
                    >
                      {file.displayPath}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="px-2 py-1.5">
                  {file.changeType ?? "—"}
                </TableCell>
                <TableCell className="px-2 py-1.5 text-right">
                  {file.changedCoveredLines} / {file.changedExecutableLines}
                </TableCell>
                <TableCell className="px-2 py-1.5 text-right">
                  <CoverageValue
                    percent={percent}
                    value={file.changedLineCoverage}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SortableChangedCoverageHead({
  activeSort,
  align = "left",
  ariaLabel,
  label,
  onSort,
  sortKey,
}: {
  activeSort: ChangedCoverageSort;
  align?: "left" | "right";
  ariaLabel: string;
  label: string;
  onSort: (key: ChangedCoverageSortKey) => void;
  sortKey: ChangedCoverageSortKey;
}) {
  const active = activeSort.key === sortKey;
  return (
    <SortableTableHead
      active={active}
      align={align}
      ariaLabel={ariaLabel}
      direction={activeSort.direction}
      label={label}
      onSort={() => onSort(sortKey)}
    />
  );
}
