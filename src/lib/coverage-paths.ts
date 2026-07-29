/**
 * Coverage reports record absolute paths as they existed on the build machine,
 * while diffs and file lists speak in worktree-relative paths. Everything that
 * joins the two goes through here.
 */

/**
 * Rewrites an absolute coverage path as worktree-relative, using forward
 * slashes. Paths outside the worktree are returned unchanged rather than
 * mangled, which keeps an unmatched entry visibly absolute instead of silently
 * colliding with a relative one.
 */
export function relativeCoveragePath(
  path: string,
  worktreeFolder: string | null,
): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRoot = worktreeFolder
    ?.replaceAll("\\", "/")
    .replace(/\/$/, "");
  if (!normalizedRoot) return normalizedPath;
  if (normalizedPath === normalizedRoot) return ".";
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}
