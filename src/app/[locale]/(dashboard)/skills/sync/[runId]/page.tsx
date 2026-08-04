import { SkillSyncPage } from "@/components/skills/skill-sync-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function SkillSyncRoute({
  params,
}: {
  params: Promise<{ locale: string; runId: string }>;
}) {
  const { runId } = await params;
  return (
    <div className="space-y-6 [&>*]:!mx-0 [&>*]:!w-full [&>*]:!max-w-none">
      <SkillSyncPage key={runId} runId={runId} />
      <WorkflowResourcePanel
        resourceId={runId}
        resourceKind="SKILL_SYNC"
        sessionData={{ skillSync: { id: runId } }}
      />
    </div>
  );
}
