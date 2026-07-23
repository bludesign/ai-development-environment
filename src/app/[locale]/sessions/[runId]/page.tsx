import { RunDetailPage } from "@/components/runs/run-detail-page";

export default async function SessionDetailRoute({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  return <RunDetailPage runId={(await params).runId} />;
}
