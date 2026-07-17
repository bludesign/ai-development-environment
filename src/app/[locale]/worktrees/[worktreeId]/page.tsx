import { WorktreeDetailPage } from "@/components/worktrees/worktree-detail-page";

export default async function WorktreeDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; worktreeId: string }>;
}) {
  const { worktreeId } = await params;
  return <WorktreeDetailPage key={worktreeId} worktreeId={worktreeId} />;
}
