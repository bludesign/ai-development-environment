import { CoverageReportPage } from "@/components/builds/coverage-report-page";

export default async function CoverageReportRoute({
  params,
}: {
  params: Promise<{ locale: string; buildId: string }>;
}) {
  const { buildId } = await params;
  return <CoverageReportPage buildId={buildId} key={buildId} />;
}
