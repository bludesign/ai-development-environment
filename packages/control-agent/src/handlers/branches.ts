import {
  codebaseBranchesDeletePayload,
  type CodebaseBranchDeletionOutcome,
  type LocalBranchInventory,
  type CodebaseSnapshot,
} from "@ai-development-environment/agent-contract/codebases";

import { branchError, branchGit, scanLocalBranches } from "./local-branches.js";
export { scanLocalBranches } from "./local-branches.js";
import { inspectCodebase } from "./codebases.js";
import type { AgentJobHandler } from "./index.js";

/** Dedicated local-only batch; no arbitrary Git operation or remote deletion is accepted. */
export const deleteLocalBranches: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
  _onLog,
  context,
) => {
  const input = codebaseBranchesDeletePayload(payload);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, Math.min(30_000, deadline - Date.now()));
  const branchDeletionResults: CodebaseBranchDeletionOutcome[] = [];
  for (const target of input.targets) {
    const outcome: CodebaseBranchDeletionOutcome = {
      codebaseId: input.codebaseId,
      branch: target.branch,
      outcome: "SKIPPED",
      reason: null,
    };
    try {
      if (signal.aborted || remaining() <= 0)
        throw new Error(
          "Branch operation interrupted; refresh before retrying",
        );
      const snapshot = await inspectCodebase(
        input.folder,
        remaining(),
        signal,
        input.expectedOrigin,
      );
      if (snapshot.availability !== "AVAILABLE")
        throw new Error(snapshot.error || "Codebase is unavailable");
      const inventory = await scanLocalBranches(
        snapshot.folder,
        remaining(),
        signal,
        target.branch,
      );
      const selected = inventory.branches.find(
        (branch) => branch.name === target.branch,
      );
      const remoteHead = await branchGit(
        snapshot.folder,
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        remaining(),
        signal,
      );
      const localDefault =
        remoteHead.exitCode === 0
          ? remoteHead.stdout.trim().replace(/^origin\//, "")
          : null;
      if (!selected) outcome.reason = "Local branch no longer exists";
      else if (selected.headSha !== target.expectedHeadSha)
        outcome.reason = "Branch tip changed; refresh and select it again";
      else if (selected.current)
        outcome.reason = "The current branch cannot be deleted";
      else if (
        selected.name === input.defaultBranch ||
        selected.name === localDefault
      )
        outcome.reason = "The default branch cannot be deleted";
      else if (selected.checkedOutPath)
        outcome.reason = `Branch is checked out at ${selected.checkedOutPath}`;
      else if (!input.defaultBranch && !localDefault)
        outcome.reason =
          "The default branch is unknown; configure it before cleanup";
      else {
        const deleted = await branchGit(
          snapshot.folder,
          ["branch", input.force ? "-D" : "--delete", "--", selected.name],
          remaining(),
          signal,
        );
        outcome.outcome = deleted.exitCode === 0 ? "DELETED" : "FAILED";
        outcome.reason =
          deleted.exitCode === 0
            ? null
            : branchError(
                deleted.stderr || "Could not safely delete local branch",
              );
      }
    } catch (error) {
      outcome.outcome = "FAILED";
      outcome.reason = branchError(error);
    }
    branchDeletionResults.push(outcome);
    try {
      if (!signal.aborted && remaining() > 0)
        await context?.reportBranchDeletionResult?.(outcome);
    } catch {
      // Completion still carries every result if progress reporting loses its connection.
    }
  }
  const localBranchInventoryAttemptedAt = new Date().toISOString();
  let localBranchInventory: LocalBranchInventory | null = null;
  let localBranchInventoryError: string | null = null;
  let snapshot: CodebaseSnapshot | undefined;
  try {
    snapshot = await inspectCodebase(
      input.folder,
      remaining(),
      signal,
      input.expectedOrigin,
    );
    if (snapshot.availability !== "AVAILABLE")
      throw new Error(snapshot.error || "Codebase is unavailable");
    localBranchInventory = await scanLocalBranches(
      snapshot.folder,
      remaining(),
      signal,
    );
  } catch (error) {
    localBranchInventoryError = branchError(error);
  }
  return {
    exitCode: 0,
    signal: null,
    cancelled: signal.aborted,
    timedOut: !signal.aborted && Date.now() >= deadline,
    ...(snapshot ? { snapshot } : {}),
    branchDeletionResults,
    localBranchInventory,
    localBranchInventoryError,
    localBranchInventoryAttemptedAt,
  };
};
