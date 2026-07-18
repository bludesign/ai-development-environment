import { BuildDetailPage } from "@/components/builds/build-detail-page";

export default async function BuildDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; buildId: string }>;
}) {
  const { buildId } = await params;
  return <BuildDetailPage buildId={buildId} key={buildId} />;
}
