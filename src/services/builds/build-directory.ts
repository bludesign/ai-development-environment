import { posix, win32 } from "node:path";

type BuildDirectoryAgent = {
  baseRepoDirectory: string | null;
  buildsDirectory: string | null;
};

export function defaultBuildsDirectory(
  baseRepoDirectory: string | null,
): string | null {
  if (!baseRepoDirectory) return null;
  const usesWindowsPath =
    /^[a-z]:[\\/]/i.test(baseRepoDirectory) ||
    baseRepoDirectory.startsWith("\\\\");
  return usesWindowsPath
    ? win32.join(baseRepoDirectory, "Builds")
    : posix.join(baseRepoDirectory, "Builds");
}

export function effectiveBuildsDirectory(
  agent: BuildDirectoryAgent,
): string | null {
  return (
    agent.buildsDirectory ?? defaultBuildsDirectory(agent.baseRepoDirectory)
  );
}

export function managedDerivedDataRoot(buildsDirectory: string): string {
  const paths =
    /^[a-z]:[\\/]/i.test(buildsDirectory) || buildsDirectory.startsWith("\\\\")
      ? win32
      : posix;
  return paths.join(buildsDirectory, ".worktree-derived-data");
}

export function worktreeDerivedDataDirectory(
  buildsDirectory: string,
  worktreeId: string,
): string {
  if (
    !worktreeId ||
    worktreeId === "." ||
    worktreeId === ".." ||
    /[\\/\0]/.test(worktreeId)
  ) {
    throw new Error(
      "Worktree identifier cannot be used as a Derived Data directory",
    );
  }
  const paths =
    /^[a-z]:[\\/]/i.test(buildsDirectory) || buildsDirectory.startsWith("\\\\")
      ? win32
      : posix;
  return paths.join(managedDerivedDataRoot(buildsDirectory), worktreeId);
}
