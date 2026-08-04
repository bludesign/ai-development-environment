import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The control plane rejects a checkpoint whose patch, summary, or manifest is
// longer than these limits, so the agent stops reading git once it has enough
// rather than buffering a whole worktree diff it would only discard.
const PATCH_LIMIT = 2_000_000;
const SUMMARY_LIMIT = 240_000;
const MANIFEST_LIMIT = 2_000_000;
const TRUNCATION_RESERVE = 200;

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

// Streams stdout and stops the child as soon as `limit` bytes have arrived. A
// diff of a large or binary worktree can be hundreds of megabytes, which
// execFile turns into "stdout maxBuffer length exceeded" and fails the run.
function cappedGit(
  cwd: string,
  args: string[],
  limit: number,
): Promise<string> {
  const budget = limit - TRUNCATION_RESERVE;
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let collected = 0;
    let errorCollected = 0;
    let truncated = false;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = budget - collected;
      if (chunk.length >= remaining) {
        chunks.push(chunk.subarray(0, remaining));
        collected = budget;
        truncated = true;
        child.stdout.destroy();
        if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
      collected += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorCollected >= 8_192) return;
      errorChunks.push(chunk);
      errorCollected += chunk.length;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (!truncated && exitCode !== 0) {
        const message =
          Buffer.concat(errorChunks).toString("utf8").trim() ||
          `git ${args[0]} exited with code ${exitCode}`;
        reject(new Error(message));
        return;
      }
      const output = Buffer.concat(chunks).toString("utf8");
      resolve(
        truncated
          ? `${output.trimEnd()}\n\n[Truncated after ${budget} bytes]`
          : output.trim(),
      );
    });
  });
}

async function optionalCappedGit(
  cwd: string,
  args: string[],
  limit: number,
): Promise<string | null> {
  try {
    return (await cappedGit(cwd, args, limit)) || null;
  } catch {
    return null;
  }
}

// The manifest travels as JSON, so escaping decides how much porcelain output
// fits inside the control plane's limit.
function manifestPayload(manifest: string): string {
  let value = manifest;
  let json = JSON.stringify({ porcelainV2: value });
  while (json.length > MANIFEST_LIMIT && value.length > 0) {
    value = value.slice(
      0,
      Math.floor((value.length * MANIFEST_LIMIT) / json.length) - 1,
    );
    json = JSON.stringify({ porcelainV2: value });
  }
  return json;
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
  const worktreePatch = await cappedGit(
    cwd,
    [
      "diff",
      "--binary",
      "--find-renames",
      target.worktreeTree,
      current.worktreeTree,
    ],
    PATCH_LIMIT,
  );
  const indexPatch =
    target.indexTree && current.indexTree
      ? await cappedGit(
          cwd,
          [
            "diff",
            "--binary",
            "--find-renames",
            target.indexTree,
            current.indexTree,
          ],
          PATCH_LIMIT,
        )
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
      .slice(0, PATCH_LIMIT),
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
  const manifest = await optionalCappedGit(
    cwd,
    ["status", "--porcelain=v2", "-z"],
    MANIFEST_LIMIT,
  );
  const staged = await optionalCappedGit(
    cwd,
    ["diff", "--cached", "--stat", "HEAD"],
    SUMMARY_LIMIT,
  );
  const unstaged = await optionalCappedGit(
    cwd,
    ["diff", "--stat", "HEAD"],
    SUMMARY_LIMIT,
  );
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
    manifestJson: manifestPayload(manifest ?? ""),
    diffSummary:
      [staged && `Staged:\n${staged}`, unstaged && `Working tree:\n${unstaged}`]
        .filter(Boolean)
        .join("\n\n") || null,
    diffPatch:
      headSha && worktreeTree
        ? (await cappedGit(
            cwd,
            ["diff", "--binary", "--find-renames", headSha, worktreeTree],
            PATCH_LIMIT,
          )) || null
        : null,
  };
}
