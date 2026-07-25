import type { WorkflowCondition } from "@/lib/workflows/session";

/**
 * The comparison a condition row shows in the builder. Each entry pairs the
 * evaluator's operator with whether the row is wrapped in `NOT`, so the negative
 * readings ("does not contain", "is not set") are ordinary dropdown choices
 * rather than a second control.
 */
export const CONDITION_OPERATORS = [
  { value: "EQ", op: "EQ", negate: false },
  { value: "NE", op: "NE", negate: false },
  { value: "CONTAINS", op: "CONTAINS", negate: false },
  { value: "NOT_CONTAINS", op: "CONTAINS", negate: true },
  { value: "MATCHES", op: "MATCHES", negate: false },
  { value: "NOT_MATCHES", op: "MATCHES", negate: true },
  { value: "GT", op: "GT", negate: false },
  { value: "GTE", op: "GTE", negate: false },
  { value: "LT", op: "LT", negate: false },
  { value: "LTE", op: "LTE", negate: false },
  { value: "EXISTS", op: "EXISTS", negate: false },
  { value: "NOT_EXISTS", op: "EXISTS", negate: true },
] as const;

export type ConditionOperatorKey =
  (typeof CONDITION_OPERATORS)[number]["value"];

/** Operators that compare against nothing — the row hides its value control. */
export function conditionOperatorTakesValue(
  key: ConditionOperatorKey,
): boolean {
  return key !== "EXISTS" && key !== "NOT_EXISTS";
}

export type ConditionRow = {
  /** Session path the comparison reads. */
  path: string;
  operator: ConditionOperatorKey;
  /** Raw workflow value: a literal, or a `{ source: "SESSION", path }` binding. */
  value: unknown;
};

export type ConditionDraft = {
  mode: "ALL" | "ANY";
  rows: ConditionRow[];
};

export const EMPTY_CONDITION_DRAFT: ConditionDraft = { mode: "ALL", rows: [] };

function sessionPath(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.source !== "SESSION" || typeof record.path !== "string")
    return null;
  return record.path;
}

function parseRow(value: unknown): ConditionRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const negated = record.op === "NOT";
  const comparison = negated
    ? (record.condition as Record<string, unknown> | undefined)
    : record;
  if (!comparison || typeof comparison !== "object") return null;
  const operator = CONDITION_OPERATORS.find(
    ({ op, negate }) => op === comparison.op && negate === negated,
  );
  if (!operator) return null;
  const path = sessionPath(comparison.left);
  if (path === null) return null;
  return { path, operator: operator.value, value: comparison.right };
}

/**
 * Reads a stored condition back into the builder's flat shape. Returns null for
 * anything the builder cannot round-trip — nested groups, a left side that is
 * not a session binding — so the caller can fall back to the JSON editor rather
 * than silently rewriting a condition it does not understand.
 */
export function parseConditionDraft(value: unknown): ConditionDraft | null {
  if (value === undefined || value === null) return EMPTY_CONDITION_DRAFT;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.op === "ALL" || record.op === "ANY") {
    const entries = record.conditions;
    if (!Array.isArray(entries)) return null;
    const rows: ConditionRow[] = [];
    for (const entry of entries) {
      const row = parseRow(entry);
      if (!row) return null;
      rows.push(row);
    }
    return { mode: record.op, rows };
  }
  const row = parseRow(record);
  return row ? { mode: "ALL", rows: [row] } : null;
}

function serializeRow(row: ConditionRow): WorkflowCondition {
  const operator = CONDITION_OPERATORS.find(
    ({ value }) => value === row.operator,
  )!;
  const comparison = {
    op: operator.op,
    left: { source: "SESSION", path: row.path },
    ...(conditionOperatorTakesValue(row.operator)
      ? { right: row.value }
      : null),
  } as WorkflowCondition;
  return operator.negate
    ? ({ op: "NOT", condition: comparison } as WorkflowCondition)
    : comparison;
}

/**
 * Writes the builder's rows back out. A lone row is stored bare rather than
 * wrapped in a one-entry group, which keeps hand-written conditions recognizable
 * in the raw-JSON view; an empty builder clears the field.
 */
export function serializeConditionDraft(
  draft: ConditionDraft,
): WorkflowCondition | undefined {
  if (draft.rows.length === 0) return undefined;
  if (draft.rows.length === 1) return serializeRow(draft.rows[0]!);
  return { op: draft.mode, conditions: draft.rows.map(serializeRow) };
}

/**
 * Turns typed text into the scalar it reads as: `2` compares as a number and
 * `true` as a boolean, while `ready` stays text. JSON quoting is the escape
 * hatch for text that looks like something else — `"2"` compares as a string.
 */
export function parseConditionValue(text: string): unknown {
  if (text === "") return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Inverse of {@link parseConditionValue}, including the quoting escape hatch. */
export function conditionValueText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string")
    return parseConditionValue(value) === value ? value : JSON.stringify(value);
  return JSON.stringify(value) ?? "";
}
