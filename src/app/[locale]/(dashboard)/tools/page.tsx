import { ToolsPage } from "@/components/tools/tools-page";
import { getEnrollmentServerOrigins } from "@/server/enrollment-server-origins";
import { connection } from "next/server";

export default async function Page() {
  await connection();
  return <ToolsPage localServerOrigins={getEnrollmentServerOrigins()} />;
}
