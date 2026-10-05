import { WorkflowDetailPage } from "@/components/workflows/workflow-detail-page";

export default async function WorkflowDetailRoute({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  return <WorkflowDetailPage workflowId={(await params).workflowId} />;
}
