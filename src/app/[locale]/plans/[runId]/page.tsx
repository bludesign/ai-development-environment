import { RunDetailPage } from "@/components/runs/run-detail-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function PlanDetailRoute({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const runId = (await params).runId;
  return (
    <div className="space-y-6 [&>*]:!mx-0 [&>*]:!w-full [&>*]:!max-w-none">
      <RunDetailPage runId={runId} />
      <WorkflowResourcePanel
        resourceId={runId}
        resourceKind="AGENT_RUN"
        sessionData={{ run: { id: runId, kind: "PLAN" } }}
      />
    </div>
  );
}
