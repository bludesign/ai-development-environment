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
