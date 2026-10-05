import { CommandRunPage } from "@/components/commands/command-run-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function CommandRunRoute({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return (
    <div className="space-y-6 [&>*]:!mx-0 [&>*]:!w-full [&>*]:!max-w-none">
      <CommandRunPage runId={runId} />
      <WorkflowResourcePanel
        resourceId={runId}
        resourceKind="COMMAND_RUN"
        sessionData={{ command: { id: runId } }}
      />
    </div>
  );
}
