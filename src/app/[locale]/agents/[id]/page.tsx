import { AgentDetail } from "@/components/agents/agent-detail";

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { id } = await params;
  return <AgentDetail agentId={id} />;
}
