"use client";

import { ArrowLeft, Search } from "lucide-react";
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

export function CoverageReportPage({ buildId }: { buildId: string }) {
  const t = useTranslations("builds");
  const locale = useLocale();
  const [report, setReport] = useState<BuildReport | null>(null);
  const [buildName, setBuildName] = useState(buildId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
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
      setBuildName(configuration?.name ?? buildId);
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

  const files = useMemo(
    () =>
      (Array.isArray(report?.data.files)
        ? (report.data.files as CoverageFile[])
        : []
      ).filter((file) =>
        `${file.target} ${file.name} ${file.path}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
      ),
    [report, search],
  );
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
          value={percent(report.summary.changedLineCoverage)}
        />
      </div>
      {changedFiles.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("changedFilesCoverage")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CoverageChangedTable files={changedFiles} percent={percent} />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("allCoverageFiles")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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
            <Table className="min-w-[60rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("coverageTarget")}</TableHead>
                  <TableHead>{t("coverageFile")}</TableHead>
                  <TableHead className="text-right">
                    {t("coveredLines")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("uncoveredLines")}
                  </TableHead>
                  <TableHead className="text-right">{t("coverage")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((file, index) => (
                  <TableRow key={`${file.target}:${file.path}:${index}`}>
                    <TableCell>
                      <Badge variant="outline">{file.target}</Badge>
                    </TableCell>
                    <TableCell className="max-w-xl whitespace-normal">
                      <p className="font-medium">{file.name}</p>
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {file.path}
                      </p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {file.coveredLines} / {file.executableLines}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Math.max(0, file.executableLines - file.coveredLines)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {percent(file.lineCoverage)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function CoverageChangedTable({
  files,
  percent,
}: {
  files: ChangedCoverageFile[];
  percent: (value: unknown) => string;
}) {
  const t = useTranslations("builds");
  return (
    <div className="overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("coverageFile")}</TableHead>
            <TableHead>{t("changeType")}</TableHead>
            <TableHead className="text-right">{t("coveredLines")}</TableHead>
            <TableHead className="text-right">{t("coverage")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => (
            <TableRow key={file.path}>
              <TableCell className="font-mono text-xs">{file.path}</TableCell>
              <TableCell>{file.changeType ?? "—"}</TableCell>
              <TableCell className="text-right">
                {file.changedCoveredLines} / {file.changedExecutableLines}
              </TableCell>
              <TableCell className="text-right">
                {percent(file.changedLineCoverage)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
