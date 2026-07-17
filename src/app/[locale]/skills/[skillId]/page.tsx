import { SkillDetailPage } from "@/components/skills/skill-detail-page";

export default async function SkillDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; skillId: string }>;
}) {
  const { skillId } = await params;
  return <SkillDetailPage key={skillId} skillId={skillId} />;
}
