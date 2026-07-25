import { CommandRunPage } from "@/components/commands/command-run-page";

export default async function CommandRunRoute({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  return <CommandRunPage runId={(await params).runId} />;
}
