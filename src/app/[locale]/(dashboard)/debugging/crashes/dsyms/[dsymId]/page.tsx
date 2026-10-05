import { DsymDetailPage } from "@/components/crashes/dsym-detail-page";

export default async function DsymDetailRoute({
  params,
}: {
  params: Promise<{ dsymId: string }>;
}) {
  const { dsymId } = await params;
  return <DsymDetailPage dsymId={dsymId} />;
}
