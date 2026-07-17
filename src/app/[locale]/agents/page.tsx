import { AgentsList } from "@/components/agents/agents-list";
import { getEnrollmentServerOrigins } from "@/server/enrollment-server-origins";
import { connection } from "next/server";

export default async function AgentsPage() {
  await connection();

  return <AgentsList localServerOrigins={getEnrollmentServerOrigins()} />;
}
