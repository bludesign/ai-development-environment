import { SkillGroupDetailPage } from "@/components/skills/skill-group-detail-page";

export default async function SkillGroupDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; groupId: string }>;
}) {
  const { groupId } = await params;
  return <SkillGroupDetailPage groupId={groupId} key={groupId} />;
}
