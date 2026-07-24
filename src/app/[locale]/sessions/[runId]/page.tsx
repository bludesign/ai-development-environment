import { RunDetailPage } from "@/components/runs/run-detail-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function SessionDetailRoute({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const runId = (await params).runId;
  return (
    <div className="space-y-6">
      <RunDetailPage runId={runId} />
      <WorkflowResourcePanel
        resourceId={runId}
        resourceKind="AGENT_RUN"
        sessionData={{ run: { id: runId, kind: "SESSION" } }}
      />
    </div>
  );
}
