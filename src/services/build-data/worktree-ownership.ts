import { posix } from "node:path";

import {
  MANAGED_GRADLE_CACHE_DIRECTORY,
  type BuildDataScanEntry,
} from "@ai-development-environment/agent-contract/build-data";

export function buildDataWorktree<T extends { id: string; folder: string }>(
  entry: Pick<
    BuildDataScanEntry,
    "kind" | "path" | "rootPath" | "workspacePath"
  >,
  worktrees: readonly T[],
): T | undefined {
  if (!entry.workspacePath) return undefined;
  const workspace = entry.workspacePath;
  if (entry.kind === "GRADLE_PROJECT") {
    if (
      posix.basename(posix.dirname(entry.rootPath)) !==
        MANAGED_GRADLE_CACHE_DIRECTORY ||
      posix.dirname(entry.path) !== entry.rootPath
    )
      return undefined;
    const ownerId = posix.basename(entry.rootPath);
    return worktrees.find(
      ({ id, folder }) =>
        id === ownerId && folder.replace(/\/+$/, "") === workspace,
    );
  }
  return worktrees
    .filter(({ folder }) => {
      const normalized = folder === "/" ? folder : folder.replace(/\/+$/, "");
      return workspace === normalized || workspace.startsWith(`${normalized}/`);
    })
    .sort((first, second) => second.folder.length - first.folder.length)[0];
}
