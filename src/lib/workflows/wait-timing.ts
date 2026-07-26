/**
 * The two knobs every waiting step exposes: how long to keep waiting, and how
 * often to check while it does.
 *
 * Steps that park on external work — an agent job, a build, a GitHub checks
 * run — used to hard-code both. A build that legitimately takes 40 minutes hit
 * the same one-hour job ceiling as a five-second Git operation, and nothing in
 * the editor could say otherwise. Both keys are optional everywhere: leaving
 * them unset preserves each step's original timing exactly.
 *
 * `timeoutSeconds` counts from the moment the step starts waiting, and expiry
 * fails the step (its retry policy still applies). `cadenceSeconds` names the
 * gap between polls; `CONTROL_WAIT_UNTIL` already used that key, so every
 * waiting step now spells it the same way.
 */

/** One year — the ceiling `CONTROL_DELAY` has always enforced. */
export const MAX_WAIT_SECONDS = 31_536_000;
/** Below this a timeout would expire before the first poll could resolve it. */
export const MIN_WAIT_TIMEOUT_SECONDS = 10;
export const MIN_WAIT_CADENCE_SECONDS = 1;

export const WAIT_TIMEOUT_HELP =
  "How long to keep waiting before the step fails. Leave empty for the step's default.";
export const WAIT_CADENCE_HELP =
  "How often to check whether the work has finished. Leave empty for the step's default.";

type WaitConfig = Record<string, unknown>;

/**
 * Reads a seconds value that an author may have left empty, written as a
 * string, or bound to session data that resolved to something unusable. Only a
 * finite positive number counts as set; anything else falls back to the
 * caller's default rather than failing the step over a formatting slip.
 */
function seconds(value: unknown, min: number): number | null {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(MAX_WAIT_SECONDS, Math.max(min, parsed));
}

/**
 * The instant a wait should give up, or null to wait indefinitely.
 *
 * `fallbackSeconds` is the step's own budget — the agent job's timeout, say —
 * used whenever the author has not set one.
 */
export function waitTimeoutAt(
  config: WaitConfig,
  fallbackSeconds: number | null = null,
): Date | null {
  const configured = seconds(config.timeoutSeconds, MIN_WAIT_TIMEOUT_SECONDS);
  const resolved =
    configured ??
    (fallbackSeconds === null
      ? null
      : seconds(fallbackSeconds, MIN_WAIT_TIMEOUT_SECONDS));
  return resolved === null ? null : new Date(Date.now() + resolved * 1_000);
}

/** The configured poll gap in seconds, or the caller's default. */
export function waitCadenceSeconds(
  config: WaitConfig,
  fallbackSeconds: number,
): number {
  return (
    seconds(config.cadenceSeconds, MIN_WAIT_CADENCE_SECONDS) ??
    Math.max(MIN_WAIT_CADENCE_SECONDS, fallbackSeconds)
  );
}

/**
 * When to run the first poll. Steps have always looked once a second after
 * starting, which stays the default; a configured cadence applies from the
 * first poll rather than only from the second.
 */
export function waitResumeAfter(config: WaitConfig, fallbackSeconds = 1): Date {
  return new Date(
    Date.now() + waitCadenceSeconds(config, fallbackSeconds) * 1_000,
  );
}
