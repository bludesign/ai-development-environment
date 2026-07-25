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

/**
 * One option on a choice trigger. Unlike a `HUMAN_CHOICE` button, this carries
 * a `key`: it names the trigger's output handle, so it has to stay put while
 * the label is edited or an existing connection would come loose.
 */
export type TriggerChoiceRow = {
  key: string;
  label: string;
  description: string;
};

/**
 * Reads stored trigger choices into editable rows, or null when an entry is not
 * the `{ key, label, description }` object the runtime expects — so the caller
 * can fall back to the JSON editor rather than silently rewriting the config.
 */
export function parseTriggerChoices(value: unknown): TriggerChoiceRow[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const rows: TriggerChoiceRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const record = entry as Record<string, unknown>;
    const extra = Object.keys(record).filter(
      (name) => name !== "key" && name !== "label" && name !== "description",
    );
    if (extra.length > 0) return null;
    if (typeof record.key !== "string") return null;
    if (record.label !== undefined && typeof record.label !== "string")
      return null;
    if (
      record.description !== undefined &&
      typeof record.description !== "string"
    )
      return null;
    rows.push({
      key: record.key,
      label: record.label ?? "",
      description: record.description ?? "",
    });
  }
  return rows;
}

/** Writes rows back out, dropping empty descriptions and clearing an empty list. */
export function serializeTriggerChoices(
  rows: readonly TriggerChoiceRow[],
): Array<{ key: string; label: string; description?: string }> | undefined {
  if (rows.length === 0) return undefined;
  return rows.map(({ key, label, description }) =>
    description ? { key, label, description } : { key, label },
  );
}

/**
 * The handle id suggested for a label, matching `isWorkflowChoiceKey`. Used to
 * fill the key in while it still tracks the label; once the author edits the
 * key by hand it stops following.
 */
export function triggerChoiceKeyFromLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
