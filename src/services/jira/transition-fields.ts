import type { JiraNamedValue } from "./types";

export type JiraTransitionField = {
  id: string;
  name: string;
  required: boolean;
  defaultValue?: unknown;
  allowedValues: JiraNamedValue[];
};

function nonempty(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    (typeof value !== "string" || value.trim().length > 0) &&
    (typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length > 0) &&
    (!Array.isArray(value) || value.length > 0)
  );
}

/** Only declared defaults and an explicitly configured Resolution may be supplied automatically. */
export function resolveTransitionFields(
  fields: JiraTransitionField[],
  resolutionId?: string | null,
) {
  const values: Record<string, unknown> = {};
  const unresolved: string[] = [];
  for (const field of fields) {
    if (!field.required) continue;
    let value = field.defaultValue;
    const allowed = (candidate: unknown): boolean => {
      if (!nonempty(candidate)) return false;
      if (!field.allowedValues.length) return true;
      if (Array.isArray(candidate)) return candidate.every(allowed);
      const identity =
        candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? ((candidate as { id?: unknown; name?: unknown }).id ??
            (candidate as { name?: unknown }).name)
          : candidate;
      return field.allowedValues.some(
        (option) => option.id === identity || option.name === identity,
      );
    };
    if (!allowed(value))
      value =
        field.id === "resolution" && resolutionId
          ? { id: resolutionId }
          : undefined;
    if (!allowed(value)) value = undefined;
    if (nonempty(value)) values[field.id] = value;
    else unresolved.push(field.name);
  }
  return { values, unresolved };
}
