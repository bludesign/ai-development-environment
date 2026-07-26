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
