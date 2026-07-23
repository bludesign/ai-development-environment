import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function optionalGit(
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    return (await git(cwd, args)) || null;
  } catch {
    return null;
  }
}

export type GitCheckpoint = {
  kind: string;
  headSha: string | null;
  branch: string | null;
  upstreamSha: string | null;
  indexTree: string | null;
  worktreeTree: string | null;
  refName: string | null;
  manifestJson: string;
  diffSummary: string | null;
  diffPatch: string | null;
};

export type GitCheckpointReference = Pick<
  GitCheckpoint,
  | "headSha"
  | "branch"
  | "upstreamSha"
  | "indexTree"
  | "worktreeTree"
  | "refName"
>;

export async function compareGitCheckpoint(
  cwd: string,
  target: GitCheckpointReference,
  current: GitCheckpointReference,
): Promise<{ rollbackPatch: string; pushedCommitWarning: string | null }> {
  if (!target.worktreeTree || !current.worktreeTree) {
    throw new Error("The worktree checkpoint is incomplete");
  }
  const worktreePatch = await git(cwd, [
    "diff",
    "--binary",
    "--find-renames",
    target.worktreeTree,
    current.worktreeTree,
  ]);
  const indexPatch =
    target.indexTree && current.indexTree
      ? await git(cwd, [
          "diff",
          "--binary",
          "--find-renames",
          target.indexTree,
          current.indexTree,
        ])
      : "";
  const upstream = await optionalGit(cwd, ["rev-parse", "@{upstream}"]);
  const pushedCount =
    target.headSha && upstream
      ? Number(
          await optionalGit(cwd, [
            "rev-list",
            "--count",
            `${target.headSha}..${upstream}`,
          ]),
        )
      : 0;
  return {
    rollbackPatch: [
      worktreePatch &&
        `Worktree changes that will be undone:\n\n${worktreePatch}`,
      indexPatch && `Index changes that will be undone:\n\n${indexPatch}`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 2_000_000),
    pushedCommitWarning:
      pushedCount > 0
        ? `${pushedCount} commit${pushedCount === 1 ? "" : "s"} after this question appear on the upstream branch. Remote refs will not be changed.`
        : null,
  };
}

export async function restoreGitCheckpoint(
  cwd: string,
  checkpoint: GitCheckpointReference,
  options: { stash: boolean; message: string },
): Promise<string | null> {
  if (
    !checkpoint.headSha ||
    !checkpoint.worktreeTree ||
    !checkpoint.indexTree
  ) {
    throw new Error("The question checkpoint cannot be restored");
  }
  const previousStash = await optionalGit(cwd, ["rev-parse", "refs/stash"]);
  if (options.stash) {
    await git(cwd, [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      options.message,
    ]);
  }
  const currentStash = await optionalGit(cwd, ["rev-parse", "refs/stash"]);
  const stashRef =
    options.stash && currentStash !== previousStash ? currentStash : null;

  await git(cwd, ["reset", "--hard"]);
  await git(cwd, ["clean", "-fd"]);
  if (checkpoint.branch) {
    const localRef = `refs/heads/${checkpoint.branch}`;
    const existing = await optionalGit(cwd, [
      "show-ref",
      "--verify",
      "--hash",
      localRef,
    ]);
    if (existing) {
      await git(cwd, ["switch", "--force", "--", checkpoint.branch]);
    } else {
      await git(cwd, [
        "switch",
        "--force-create",
        checkpoint.branch,
        checkpoint.headSha,
      ]);
    }
    await git(cwd, ["reset", "--hard", checkpoint.headSha]);
  } else {
    await git(cwd, ["switch", "--detach", "--force", checkpoint.headSha]);
  }
  await git(cwd, ["clean", "-fd"]);
  await git(cwd, ["read-tree", "--reset", "-u", checkpoint.worktreeTree]);
  await git(cwd, ["read-tree", checkpoint.indexTree]);
  return stashRef;
}

export async function captureGitCheckpoint(
  cwd: string,
  runId: string,
  kind: string,
): Promise<GitCheckpoint> {
  const headSha = await optionalGit(cwd, ["rev-parse", "HEAD"]);
  const branch = await optionalGit(cwd, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const upstreamSha = await optionalGit(cwd, ["rev-parse", "@{upstream}"]);
  const indexTree = await optionalGit(cwd, ["write-tree"]);
  const manifest = await optionalGit(cwd, ["status", "--porcelain=v2", "-z"]);
  const staged = await optionalGit(cwd, ["diff", "--cached", "--stat", "HEAD"]);
  const unstaged = await optionalGit(cwd, ["diff", "--stat", "HEAD"]);
  const directory = await mkdtemp(join(tmpdir(), "aide-run-index-"));
  let worktreeTree: string | null = null;
  let refName: string | null = null;
  try {
    const actualIndex = await git(cwd, ["rev-parse", "--git-path", "index"]);
    const temporaryIndex = join(directory, "index");
    try {
      await copyFile(actualIndex, temporaryIndex);
    } catch {
      if (headSha) {
        await git(cwd, ["read-tree", headSha], {
          GIT_INDEX_FILE: temporaryIndex,
        });
      }
    }
    await git(cwd, ["add", "-A", "--", "."], {
      GIT_INDEX_FILE: temporaryIndex,
    });
    worktreeTree = await git(cwd, ["write-tree"], {
      GIT_INDEX_FILE: temporaryIndex,
    });
    const commitArgs = [
      "commit-tree",
      worktreeTree,
      "-m",
      `AIDE run ${runId} ${kind} checkpoint`,
    ];
    if (headSha) commitArgs.splice(2, 0, "-p", headSha);
    const checkpointCommit = await git(cwd, commitArgs, {
      GIT_AUTHOR_NAME: "AI Development Environment",
      GIT_AUTHOR_EMAIL: "aide@localhost",
      GIT_COMMITTER_NAME: "AI Development Environment",
      GIT_COMMITTER_EMAIL: "aide@localhost",
    });
    refName = `refs/aide/runs/${runId}/${Date.now()}-${kind.toLowerCase()}`;
    await git(cwd, ["update-ref", refName, checkpointCommit]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return {
    kind,
    headSha,
    branch,
    upstreamSha,
    indexTree,
    worktreeTree,
    refName,
    manifestJson: JSON.stringify({ porcelainV2: manifest ?? "" }),
    diffSummary:
      [staged && `Staged:\n${staged}`, unstaged && `Working tree:\n${unstaged}`]
        .filter(Boolean)
        .join("\n\n") || null,
    diffPatch:
      headSha && worktreeTree
        ? (
            await git(cwd, [
              "diff",
              "--binary",
              "--find-renames",
              headSha,
              worktreeTree,
            ])
          ).slice(0, 2_000_000) || null
        : null,
  };
}
