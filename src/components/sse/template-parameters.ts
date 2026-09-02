import type {
  SseMockTemplate,
  SseMockTemplateField,
  SseMockTemplateValue,
} from "./types";

const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function sseTemplateValueError(
  field: SseMockTemplateField,
  value: string,
): string | null {
  if (field.type === "TEXT") return null;
  const trimmed = value.trim();
  if (field.type === "NUMBER") {
    return JSON_NUMBER.test(trimmed) && Number.isFinite(Number(trimmed))
      ? null
      : "Enter a finite number.";
  }
  if (field.type === "BOOLEAN") {
    return trimmed === "true" || trimmed === "false"
      ? null
      : "Choose true or false.";
  }
  try {
    JSON.parse(trimmed);
    return null;
  } catch {
    return "Enter valid JSON.";
  }
}

function placeholderKeys(source: string): {
  keys: string[];
  error: string | null;
} {
  const keys: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("{{", cursor);
    if (start < 0) break;
    if (start > 0 && source[start - 1] === "\\") {
      cursor = start + 2;
      continue;
    }
    const end = source.indexOf("}}", start + 2);
    if (end < 0) return { keys, error: "A placeholder is not closed." };
    const token = source.slice(start + 2, end);
    const key = token.startsWith("json:") ? token.slice(5) : token;
    if (!FIELD_KEY.test(key)) {
      return { keys, error: `Invalid placeholder {{${token}}}.` };
    }
    keys.push(key);
    cursor = end + 2;
  }
  return { keys, error: null };
}

export function sseTemplateDraftError(template: {
  name: string;
  eventName: string;
  data: string;
  eventId: string;
  retryMs: string;
  retryMsTemplate: string;
  fields: SseMockTemplateField[];
}): string | null {
  if (!template.name.trim()) return "Template name is required.";
  if (template.retryMs && template.retryMsTemplate) {
    return "Use a fixed retry or a retry template, not both.";
  }
  if (template.retryMs) {
    const retry = Number(template.retryMs);
    if (!Number.isInteger(retry) || retry < 0 || retry > 86_400_000) {
      return "Retry must be an integer from 0 through 86400000.";
    }
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const field of template.fields) {
    if (!FIELD_KEY.test(field.key)) {
      return "Field keys must start with a letter and contain only letters, numbers, or underscores.";
    }
    if (!field.label.trim()) return `Field ${field.key} needs a label.`;
    if (ids.has(field.id) || keys.has(field.key)) {
      return "Field IDs and keys must be unique.";
    }
    ids.add(field.id);
    keys.add(field.key);
    if (field.defaultValue !== null) {
      const error = sseTemplateValueError(field, field.defaultValue);
      if (error) return `${field.label}: ${error}`;
    }
  }
  const used = new Set<string>();
  for (const source of [
    template.eventName,
    template.data,
    template.eventId,
    template.retryMsTemplate,
  ]) {
    const parsed = placeholderKeys(source);
    if (parsed.error) return parsed.error;
    for (const key of parsed.keys) {
      if (!keys.has(key)) return `Placeholder ${key} has no field definition.`;
      used.add(key);
    }
  }
  const unused = template.fields.find((field) => !used.has(field.key));
  return unused ? `Field ${unused.key} is not used in the event.` : null;
}

export function sseTemplateBlockError(
  template: SseMockTemplate,
  values: Record<string, string> | undefined,
): string | null {
  for (const field of template.fields) {
    const override = values?.[field.id];
    if (override === undefined) {
      if (field.required && field.defaultValue === null) {
        return `${field.label} is required.`;
      }
      continue;
    }
    const error = sseTemplateValueError(field, override);
    if (error) return `${field.label}: ${error}`;
  }
  return null;
}

export function sseTemplateValuesRecord(
  values: SseMockTemplateValue[],
): Record<string, string> {
  return Object.fromEntries(
    values.map((value) => [value.fieldId, value.value]),
  );
}

export function sseTemplateValuesInput(
  values: Record<string, string> | undefined,
): SseMockTemplateValue[] {
  return Object.entries(values ?? {}).map(([fieldId, value]) => ({
    fieldId,
    value,
  }));
}
