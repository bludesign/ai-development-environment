export type DirtyDurationCursor = { dirtySince: number | null };

/** The clock belongs to the trigger cursor, so agent polling and restarts do not reset it. */
export function observeDirtyDuration(input: {
  dirty: boolean;
  durationSeconds?: unknown;
  now: number;
  previousCursor?: unknown;
  previouslyMatched?: boolean;
}) {
  const durationSeconds = input.durationSeconds ?? 3600;
  if (
    typeof durationSeconds !== "number" ||
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > 31536000
  ) {
    throw new Error(
      "Dirty duration must be an integer between 1 and 31536000 seconds",
    );
  }
  const previous =
    input.previousCursor &&
    typeof input.previousCursor === "object" &&
    "dirtySince" in input.previousCursor
      ? input.previousCursor.dirtySince
      : null;
  const dirtySince = input.dirty
    ? typeof previous === "number" &&
      Number.isFinite(previous) &&
      previous <= input.now
      ? previous
      : input.now
    : null;
  const matched =
    dirtySince !== null && input.now - dirtySince >= durationSeconds * 1000;
  return {
    cursor: { dirtySince } satisfies DirtyDurationCursor,
    matched,
    fire: matched && !input.previouslyMatched,
  };
}
