import { CodebaseDetailPage } from "@/components/codebases/codebase-detail-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function CodebaseDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; codebaseId: string }>;
}) {
  const { codebaseId } = await params;
  return (
    <div className="space-y-6">
      <CodebaseDetailPage codebaseId={codebaseId} />
      <WorkflowResourcePanel
        resourceId={codebaseId}
        resourceKind="CODEBASE"
        sessionData={{ codebase: { id: codebaseId } }}
      />
    </div>
  );
}
