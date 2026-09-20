"use client";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { WorktreeMove } from "./types";

export type WorktreeOperationJobResult = {
  outcome: "COMPLETED" | "PREPARATION_CONFLICT" | "REBASE_CONFLICT";
  preparationConflictPaths: string[];
};

export async function waitForWorktreeOperationJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<WorktreeOperationJobResult | null> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await waitForPoll(signal);
    const data = await controlPlaneRequest<{
      agentJob: {
        status: string;
        error: string | null;
        worktreeOperationResult: WorktreeOperationJobResult | null;
      } | null;
    }>(
      `query WorktreeJob($id: ID!) {
        agentJob(id: $id) {
          status error
          worktreeOperationResult { outcome preparationConflictPaths }
        }
      }`,
      { id: jobId },
      { signal },
    );
    const job = data.agentJob;
    if (!job || ["QUEUED", "RUNNING"].includes(job.status)) continue;
    if (job.status !== "SUCCEEDED") {
      throw new Error(
        job.error || `Worktree operation ${job.status.toLowerCase()}`,
      );
    }
    return job.worktreeOperationResult;
  }
  throw new Error(
    "Worktree operation is still running; check the agent job history",
  );
}

export async function waitForWorktreeJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<void> {
  await waitForWorktreeOperationJob(jobId, signal);
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

function waitForPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, 750);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Poll a preparation batch once per interval instead of once per codebase. */
export async function waitForWorktreeJobs(
  ids: string[],
  signal?: AbortSignal,
): Promise<void> {
  const pending = new Set(ids);
  const deadline = Date.now() + 10 * 60_000;
  while (pending.size && Date.now() < deadline) {
    await waitForPoll(signal);
    const keys = [...pending];
    for (let offset = 0; offset < keys.length; offset += 200) {
      const data = await controlPlaneRequest<{
        agentJobsByIds: Array<{
          id: string;
          status: string;
          error: string | null;
        }>;
      }>(
        "query WorktreePreparationJobs($ids: [ID!]!) { agentJobsByIds(ids: $ids) { id status error } }",
        { ids: keys.slice(offset, offset + 200) },
        { signal },
      );
      for (const job of data.agentJobsByIds) {
        if (["QUEUED", "RUNNING"].includes(job.status)) continue;
        if (job.status !== "SUCCEEDED")
          throw new Error(
            job.error || `Worktree operation ${job.status.toLowerCase()}`,
          );
        pending.delete(job.id);
      }
    }
  }
  if (pending.size)
    throw new Error(
      "Worktree operation is still running; check the agent job history",
    );
}
