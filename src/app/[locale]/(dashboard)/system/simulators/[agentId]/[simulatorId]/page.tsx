import { SimulatorDetailPage } from "@/components/simulators/simulator-detail-page";

export default async function SimulatorDetailRoute({
  params,
}: {
  params: Promise<{ agentId: string; simulatorId: string }>;
}) {
  const { agentId, simulatorId } = await params;
  return (
    <SimulatorDetailPage
      agentId={agentId}
      key={`${agentId}:${simulatorId}`}
      simulatorId={simulatorId}
    />
  );
}
