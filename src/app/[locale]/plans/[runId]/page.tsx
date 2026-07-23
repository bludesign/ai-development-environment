import { RunDetailPage } from "@/components/runs/run-detail-page";

export default async function PlanDetailRoute({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  return <RunDetailPage runId={(await params).runId} />;
}
