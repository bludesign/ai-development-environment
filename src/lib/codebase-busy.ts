/**
 * Raised when a codebase already has an active agent job and the caller cannot
 * take the single active-job slot enforced by the `AgentJob_codebaseId_active_key`
 * partial unique index.
 *
 * It is thrown before any agent job is created, so callers that can afford to
 * wait — the workflow runtime in particular — may safely hold the work and try
 * again instead of failing.
 */
export class CodebaseBusyError extends Error {
  constructor(message = "Another operation is active for this codebase") {
    super(message);
    this.name = "CodebaseBusyError";
  }
}

export function isCodebaseBusyError(error: unknown): boolean {
  return error instanceof Error && error.name === "CodebaseBusyError";
}

/**
 * Recognises the raw Prisma violation of `AgentJob_codebaseId_active_key`, which
 * surfaces as a P2002 naming `codebaseId` as its only target. Job creation
 * translates it into {@link CodebaseBusyError}, so callers that sit above that
 * translation should prefer {@link isCodebaseBusyError}; this stays available for
 * code that talks to Prisma directly.
 */
export function isActiveCodebaseJobConflict(error: unknown): boolean {
  if (isCodebaseBusyError(error)) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; meta?: { target?: unknown } };
  if (value.code !== "P2002") return false;
  const target = value.meta?.target;
  return Array.isArray(target)
    ? target.includes("codebaseId")
    : typeof target === "string" && target.includes("codebaseId");
}
