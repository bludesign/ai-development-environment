import { CrashDetailPage } from "@/components/crashes/crash-detail-page";

export default async function CrashDetailRoute({
  params,
}: {
  params: Promise<{ crashId: string }>;
}) {
  const { crashId } = await params;
  return <CrashDetailPage crashId={crashId} />;
}
