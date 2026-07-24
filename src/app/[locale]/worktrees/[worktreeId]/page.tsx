import { WorktreeDetailPage } from "@/components/worktrees/worktree-detail-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function WorktreeDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; worktreeId: string }>;
}) {
  const { worktreeId } = await params;
  return (
    <div className="space-y-6 [&>*]:!mx-0 [&>*]:!w-full [&>*]:!max-w-none">
      <WorktreeDetailPage worktreeId={worktreeId} />
      <WorkflowResourcePanel
        resourceId={worktreeId}
        resourceKind="WORKTREE"
        sessionData={{ worktree: { id: worktreeId } }}
      />
    </div>
  );
}
