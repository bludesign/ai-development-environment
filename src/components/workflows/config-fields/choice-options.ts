/**
 * One button offered by a `HUMAN_CHOICE` step. The runtime stores an option as
 * `{ label, description }`, and the description is optional.
 */
export type ChoiceOptionRow = { label: string; description: string };

/**
 * Reads stored options into editable rows, or null when an entry is not the
 * `{ label, description }` object the runtime expects — a session binding or a
 * bare string — so the caller can fall back to the JSON editor.
 */
export function parseChoiceOptions(value: unknown): ChoiceOptionRow[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const rows: ChoiceOptionRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const record = entry as Record<string, unknown>;
    const extra = Object.keys(record).filter(
      (key) => key !== "label" && key !== "description",
    );
    if (extra.length > 0) return null;
    if (typeof record.label !== "string") return null;
    if (
      record.description !== undefined &&
      typeof record.description !== "string"
    )
      return null;
    rows.push({ label: record.label, description: record.description ?? "" });
  }
  return rows;
}

/** Writes rows back out, dropping empty descriptions and clearing an empty list. */
export function serializeChoiceOptions(
  rows: readonly ChoiceOptionRow[],
): Array<{ label: string; description?: string }> | undefined {
  if (rows.length === 0) return undefined;
  return rows.map(({ label, description }) =>
    description ? { label, description } : { label },
  );
}
