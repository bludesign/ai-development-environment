import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import { worktreePostMergeSwitchJobPayload } from "@ai-development-environment/agent-contract/worktrees";
import { sourceBranchResource } from "@ai-development-environment/agent-contract/operation-resources";

import { captureCommand } from "../capture-command.js";
import { withRepositoryMetadata } from "../repository-metadata.js";
import type { AgentJobHandler } from "./index.js";
import { inspectWorktreeItem } from "./worktrees.js";

/** Switch only the reviewed primary checkout, after origin contains the confirmed merge. */
export const postMergeSwitch: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
  onLog,
  context,
) => {
  const input = worktreePostMergeSwitchJobPayload(payload);
  const folder = await realpath(input.folder);
  const deadline = Date.now() + timeoutMs;
  let sequence = 0;
  const git = async (
    args: string[],
    allowFailure = false,
    until = deadline,
  ) => {
    signal.throwIfAborted();
    const remaining = Math.min(deadline, until) - Date.now();
    if (remaining <= 0) throw new Error("Post-merge branch switch timed out");
    const result = await captureCommand({
      command: "git",
      args: ["-C", folder, ...args],
      timeoutMs: Math.min(30_000, remaining),
      signal,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (result.cancelled || result.timedOut || result.outputTruncated)
      throw new Error(
        "Post-merge Git operation was interrupted or its output was incomplete",
      );
    if (result.exitCode !== 0 && !allowFailure)
      throw new Error(
        (result.stderr || `Post-merge Git ${args[0]} failed`)
          .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1")
          .slice(0, 2_000),
      );
    return result;
  };
  const text = async (args: string[]) => (await git(args)).stdout.trim();
  const ancestor = async (older: string, newer: string) => {
    const result = await git(
      ["merge-base", "--is-ancestor", older, newer],
      true,
    );
    if (result.exitCode !== 0 && result.exitCode !== 1)
      throw new Error("Could not verify post-merge commit ancestry");
    return result.exitCode === 0;
  };
  const validateIdentity = async () => {
    const directory = await realpath(
      await text(["rev-parse", "--path-format=absolute", "--git-dir"]),
    );
    const common = await realpath(
      await text(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const root = await realpath(await text(["rev-parse", "--show-toplevel"]));
    if (
      directory !== input.gitDirectory ||
      common !== directory ||
      root !== folder
    )
      throw new Error(
        "The linked primary worktree identity changed after merge",
      );
    if (
      normalizeGitOrigin(await text(["remote", "get-url", "origin"]))
        .canonicalOrigin !== input.expectedOrigin
    )
      throw new Error("The primary worktree origin changed after merge");
  };
  const clean = async () => {
    if (
      (
        await git([
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ])
      ).stdout
    )
      throw new Error(
        "Commit or stash primary worktree changes before switching after merge",
      );
    for (const marker of [
      "MERGE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "sequencer",
      "BISECT_START",
      "BISECT_LOG",
    ]) {
      // Identity validation requires the primary checkout, whose operation
      // markers all live directly in its common Git directory.
      const path = join(input.gitDirectory, marker);
      try {
        await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error(
        "Finish the active Git operation before switching after merge",
      );
    }
  };
  const currentBranch = () => text(["symbolic-ref", "--short", "HEAD"]);
  const ensureDestinationFree = async () => {
    const listing = await text(["worktree", "list", "--porcelain", "-z"]);
    if (listing.split("\0").includes(`branch refs/heads/${input.branch}`))
      throw new Error(
        `Branch ${input.branch} is checked out in another worktree`,
      );
  };
  const execute = () =>
    withRepositoryMetadata(
      folder,
      async () => {
        await validateIdentity();
        await clean();
        const startingBranch = await currentBranch();
        const startingHead = await text(["rev-parse", "HEAD"]);
        const replay = startingBranch === input.branch;
        if (
          !replay &&
          (startingBranch !== input.expectedBranch ||
            startingHead !== input.expectedHeadSha)
        )
          throw new Error(
            "The primary worktree source branch or HEAD changed after merge",
          );
        const guard = async () => {
          await validateIdentity();
          await clean();
          if (
            (await currentBranch()) !== startingBranch ||
            (await text(["rev-parse", "HEAD"])) !== startingHead
          )
            throw new Error(
              "The primary worktree source branch or HEAD changed after merge",
            );
        };
        const remoteRef = `refs/remotes/origin/${input.branch}`;
        const fetchDeadline = Math.min(deadline, Date.now() + 120_000);
        let targetSha: string;
        while (true) {
          if (Date.now() >= fetchDeadline)
            throw new Error(
              "Origin does not yet contain the confirmed merge commit; retry the post-merge switch",
            );
          await git(
            [
              "fetch",
              "--no-tags",
              "origin",
              `+refs/heads/${input.branch}:${remoteRef}`,
            ],
            false,
            fetchDeadline,
          );
          targetSha = await text([
            "rev-parse",
            "--verify",
            `${remoteRef}^{commit}`,
          ]);
          const mergedObject = await git(
            ["cat-file", "-e", `${input.mergeCommitSha}^{commit}`],
            true,
          );
          if (
            mergedObject.exitCode === 0 &&
            (await ancestor(input.mergeCommitSha, targetSha))
          )
            break;
          if (Date.now() >= fetchDeadline)
            throw new Error(
              "Origin does not yet contain the confirmed merge commit; retry the post-merge switch",
            );
          await onLog({
            sequence: sequence++,
            stream: "SYSTEM",
            message: "Waiting for origin to contain the confirmed merge commit",
            createdAt: new Date().toISOString(),
          });
          await delay(
            Math.min(1_000, Math.max(0, fetchDeadline - Date.now())),
            undefined,
            { signal },
          );
        }
        await guard();
        let outcome: "SWITCHED" | "ALREADY_SWITCHED";
        if (replay) {
          if (!(await ancestor(input.mergeCommitSha, startingHead)))
            throw new Error(
              "The primary checkout changed to a destination that does not contain the confirmed merge",
            );
          outcome = "ALREADY_SWITCHED";
        } else {
          await ensureDestinationFree();
          const localRef = `refs/heads/${input.branch}`;
          if (
            (await git(["symbolic-ref", "--quiet", localRef], true))
              .exitCode === 0
          )
            throw new Error(
              "The destination branch is a symbolic ref; review it before switching",
            );
          const local = await git(
            ["rev-parse", "--verify", "--quiet", `${localRef}^{commit}`],
            true,
          );
          if (local.exitCode !== 0 && local.exitCode !== 1)
            throw new Error("Could not inspect the local destination branch");
          const oldSha = local.exitCode === 0 ? local.stdout.trim() : "";
          if (oldSha && !(await ancestor(oldSha, targetSha)))
            throw new Error(
              `Branch ${input.branch} has local commits that cannot be fast-forwarded from origin`,
            );
          await guard();
          await ensureDestinationFree();
          // Compare-and-swap also protects commits created outside the app after inspection.
          await git([
            "update-ref",
            "--no-deref",
            localRef,
            targetSha,
            oldSha || "0".repeat(targetSha.length),
          ]);
          await guard();
          await ensureDestinationFree();
          if ((await text(["rev-parse", localRef])) !== targetSha)
            throw new Error(
              "The destination branch changed before checkout; retry the follow-up",
            );
          if (!oldSha)
            await git([
              "branch",
              `--set-upstream-to=origin/${input.branch}`,
              input.branch,
            ]);
          await git(["switch", "--no-guess", input.branch]);
          outcome = "SWITCHED";
        }
        const worktree = await inspectWorktreeItem(
          folder,
          folder,
          input.branch,
          true,
          Math.max(1, deadline - Date.now()),
          signal,
        );
        if (
          worktree.availability !== "AVAILABLE" ||
          worktree.branch !== input.branch ||
          !worktree.headSha ||
          (!replay && worktree.headSha !== targetSha) ||
          !(await ancestor(input.mergeCommitSha, worktree.headSha))
        )
          throw new Error(
            "The primary checkout changed while completing its post-merge switch",
          );
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          outcome,
          worktree,
        };
      },
      signal,
    );
  return context?.withOperationResources
    ? context.withOperationResources(
        [
          {
            kind: "WORKTREE",
            key: `${context.agentId}:worktree:${input.gitDirectory}`,
            mode: "WRITE",
            agentId: context.agentId,
            codebaseId: input.codebaseId,
          },
          {
            kind: "PATH",
            key: folder,
            path: folder,
            mode: "WRITE",
            agentId: context.agentId,
            codebaseId: input.codebaseId,
          },
          sourceBranchResource(input.expectedOrigin, input.branch, "WRITE"),
        ],
        execute,
      )
    : execute();
};
