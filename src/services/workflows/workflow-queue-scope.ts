import { getPrismaClient } from "@/data/prisma-client";

/** Queue positions also change when another workflow uses the same worktree. */
export async function workflowQueueUsesWorktree(
  workflowId: string,
  worktreeId: string | null,
) {
  if (!worktreeId) return false;
  const prisma = await getPrismaClient();
  return Boolean(
    await prisma.workflowRun.findFirst({
      where: {
        workflowId,
        OR: [
          { status: "QUEUED", worktreeId },
          {
            agentRuns: {
              some: { status: "QUEUED", origin: "MANAGED", worktreeId },
            },
          },
        ],
      },
      select: { id: true },
    }),
  );
}
