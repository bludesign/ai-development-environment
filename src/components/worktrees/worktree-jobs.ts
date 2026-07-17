"use client";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { WorktreeMove } from "./types";

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

export async function waitForWorktreeMove(
  moveId: string,
): Promise<WorktreeMove> {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    const data = await controlPlaneRequest<{
      worktreeMove: WorktreeMove | null;
    }>(
      `query WorktreeMove($id: ID!) {
        worktreeMove(id: $id) {
          id sourceWorktreeId sourceCodebaseId targetCodebaseId targetWorktreeId destinationMode
          branch headSha deleteSource status sourceJobId targetJobId cleanupJobId error warning
          createdAt updatedAt finishedAt
        }
      }`,
      { id: moveId },
    );
    const move = data.worktreeMove;
    if (!move) throw new Error("Worktree move disappeared");
    if (["PUSHING", "CHECKING_OUT", "CLEANING_UP"].includes(move.status)) {
      continue;
    }
    return move;
  }
  throw new Error(
    "Worktree move is still running; it will continue in the background",
  );
}
