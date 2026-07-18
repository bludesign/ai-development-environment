import { SkillSyncPage } from "@/components/skills/skill-sync-page";

export default async function SkillSyncRoute({
  params,
}: {
  params: Promise<{ locale: string; runId: string }>;
}) {
  const { runId } = await params;
  return <SkillSyncPage key={runId} runId={runId} />;
}
