"use client";

import { controlPlaneRequest } from "@/lib/control-plane-client";

export async function waitForWorktreeJob(jobId: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    const data = await controlPlaneRequest<{
      agentJob: { status: string; error: string | null } | null;
    }>("query WorktreeJob($id: ID!) { agentJob(id: $id) { status error } }", {
      id: jobId,
    });
    const job = data.agentJob;
    if (!job || ["QUEUED", "RUNNING"].includes(job.status)) continue;
    if (job.status !== "SUCCEEDED") {
      throw new Error(
        job.error || `Worktree operation ${job.status.toLowerCase()}`,
      );
    }
    return;
  }
  throw new Error(
    "Worktree operation is still running; check the agent job history",
  );
}
