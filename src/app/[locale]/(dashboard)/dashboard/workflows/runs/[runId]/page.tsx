import { WorkflowRunPage } from "@/components/workflows/workflow-run-page";

export default async function WorkflowRunRoute({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  return <WorkflowRunPage runId={(await params).runId} />;
}
