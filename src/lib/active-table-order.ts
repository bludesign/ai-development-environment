const PRIORITIZED_STATUSES = new Set([
  "QUEUED",
  "RUNNING",
  "BLOCKED",
  "PAUSED",
  "WAITING",
  // Plans and Sessions expose a running provider turn with this status.
  "IN_PROGRESS",
]);

export const hasPrioritizedTableStatus = (status: string) =>
  PRIORITIZED_STATUSES.has(status.toUpperCase());

/**
 * Stable-partition table rows so work that is still running or needs attention
 * appears before terminal work, while retaining the API's order within each
 * partition.
 */
export function prioritizeActiveTableRows<T extends { status: string }>(
  rows: readonly T[],
): T[] {
  const prioritized: T[] = [];
  const remaining: T[] = [];
  for (const row of rows) {
    (hasPrioritizedTableStatus(row.status) ? prioritized : remaining).push(row);
  }
  return [...prioritized, ...remaining];
}
