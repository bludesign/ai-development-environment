import {
  parseLocalBranchInventory,
  type LocalBranchInventory,
} from "@ai-development-environment/agent-contract/codebases";
import { captureCommand } from "../capture-command.js";

export const branchError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1")
    .slice(0, 2_000);

export async function branchGit(
  folder: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
) {
  const result = await captureCommand({
    command: "git",
    args: ["-C", folder, ...args],
    timeoutMs,
    signal,
    maxOutputBytes: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.cancelled || result.timedOut)
    throw new Error(
      result.cancelled
        ? "Branch operation cancelled"
        : "Branch operation timed out",
    );
  if (result.outputTruncated)
    throw new Error(
      "Local branch inventory exceeded the output limit; the previous inventory was retained",
    );
  return result;
}

/** Reads local tips only. A same-named origin ref cannot affect commit dates or membership. */
export async function scanLocalBranches(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
  branch?: string,
): Promise<LocalBranchInventory> {
  const [current, refs] = await Promise.all([
    branchGit(
      folder,
      ["symbolic-ref", "--short", "-q", "HEAD"],
      timeoutMs,
      signal,
    ),
    branchGit(
      folder,
      [
        "for-each-ref",
        "--format=%(refname:strip=2)%00%(objectname)%00%(committerdate:iso-strict)%00%(contents:subject)%00%(worktreepath)",
        branch ? `refs/heads/${branch}` : "refs/heads",
      ],
      timeoutMs,
      signal,
    ),
  ]);
  if (refs.exitCode !== 0)
    throw new Error(
      branchError(refs.stderr || "Could not inspect local branches"),
    );
  return parseLocalBranchInventory({
    scannedAt: new Date().toISOString(),
    branches: refs.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, headSha, date, subject, path] = line.split("\0");
        return {
          name,
          headSha,
          lastCommitAt:
            date && Number.isFinite(Date.parse(date))
              ? new Date(date).toISOString()
              : null,
          lastCommitMessage: subject?.slice(0, 2_000) || null,
          current: current.exitCode === 0 && name === current.stdout.trim(),
          checkedOutPath: path || null,
        };
      })
      .filter((item) => !branch || item.name === branch),
  });
}

export async function localBranchReport(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
  unavailable?: string,
) {
  const localBranchInventoryAttemptedAt = new Date().toISOString();
  try {
    if (unavailable) throw new Error(unavailable);
    return {
      localBranchInventoryAttemptedAt,
      localBranchInventory: await scanLocalBranches(folder, timeoutMs, signal),
      localBranchInventoryError: null,
    };
  } catch (error) {
    return {
      localBranchInventoryAttemptedAt,
      localBranchInventory: null,
      localBranchInventoryError: branchError(error),
    };
  }
}
