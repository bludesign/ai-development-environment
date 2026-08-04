import { WorkflowEditor } from "@/components/workflows/workflow-editor";

export default async function EditWorkflowRoute({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  return <WorkflowEditor workflowId={(await params).workflowId} />;
}
