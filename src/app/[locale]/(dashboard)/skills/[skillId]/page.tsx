import { SkillDetailPage } from "@/components/skills/skill-detail-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function SkillDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; skillId: string }>;
}) {
  const { skillId } = await params;
  return (
    <div className="space-y-6 [&>*]:!mx-0 [&>*]:!w-full [&>*]:!max-w-none">
      <SkillDetailPage key={skillId} skillId={skillId} />
      <WorkflowResourcePanel
        resourceId={skillId}
        resourceKind="SKILL"
        sessionData={{ skill: { id: skillId } }}
      />
    </div>
  );
}
