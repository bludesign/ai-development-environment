import { randomUUID } from "node:crypto";

import {
  SSE_MOCK_TEMPLATE_FIELD_TYPES,
  type SseEvent,
  type SseMockTemplateField,
  type SseMockTemplateFieldInput,
  type SseMockTemplateValue,
} from "./types";

const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const MAX_FIELDS = 100;
const MAX_RETRY_MS = 86_400_000;

export type SseParameterizedTemplate = {
  eventName: string | null;
  data: string;
  eventId: string | null;
  retryMs: number | null;
  retryMsTemplate: string | null;
  fields: SseMockTemplateField[];
};

type Placeholder = {
  start: number;
  end: number;
  key: string;
  json: boolean;
};

function placeholders(source: string, label: string): Placeholder[] {
  const result: Placeholder[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("{{", cursor);
    if (start < 0) break;
    if (start > 0 && source[start - 1] === "\\") {
      cursor = start + 2;
      continue;
    }
    const end = source.indexOf("}}", start + 2);
    if (end < 0) throw new Error(`${label} contains an unclosed placeholder`);
    const token = source.slice(start + 2, end);
    const json = token.startsWith("json:");
    const key = json ? token.slice(5) : token;
    if (!FIELD_KEY.test(key)) {
      throw new Error(
        `${label} contains invalid placeholder {{${token}}}; use {{fieldKey}} or {{json:fieldKey}}`,
      );
    }
    result.push({ start, end: end + 2, key, json });
    cursor = end + 2;
  }
  return result;
}

export function validateSseTemplateFieldValue(
  field: Pick<SseMockTemplateField, "key" | "type">,
  value: string,
  label = `Value for ${field.key}`,
): string {
  if (field.type === "TEXT") return value;
  const trimmed = value.trim();
  if (field.type === "NUMBER") {
    if (!JSON_NUMBER.test(trimmed) || !Number.isFinite(Number(trimmed))) {
      throw new Error(`${label} must be a finite number`);
    }
    return trimmed;
  }
  if (field.type === "BOOLEAN") {
    if (trimmed !== "true" && trimmed !== "false") {
      throw new Error(`${label} must be exactly true or false`);
    }
    return trimmed;
  }
  try {
    JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  return trimmed;
}

export function normalizeSseTemplateFields(
  values: SseMockTemplateFieldInput[],
): SseMockTemplateField[] {
  if (values.length > MAX_FIELDS) {
    throw new Error(`A template may define at most ${MAX_FIELDS} fields`);
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  return values.map((value, index) => {
    const id = value.id?.trim() || randomUUID();
    const key = value.key.trim();
    const label = value.label.trim();
    if (!id || ids.has(id))
      throw new Error("Template field IDs must be unique");
    if (!FIELD_KEY.test(key)) {
      throw new Error(
        `Template field ${index + 1} key must start with a letter and contain only letters, numbers, or underscores`,
      );
    }
    if (keys.has(key))
      throw new Error(`Template field key ${key} is duplicated`);
    if (!label) throw new Error(`Template field ${key} requires a label`);
    if (!SSE_MOCK_TEMPLATE_FIELD_TYPES.includes(value.type)) {
      throw new Error(`Template field ${key} has an unsupported type`);
    }
    ids.add(id);
    keys.add(key);
    const field: SseMockTemplateField = {
      id,
      key,
      label,
      helpText: value.helpText?.trim() ?? "",
      type: value.type,
      required: value.required,
      defaultValue: value.defaultValue ?? null,
    };
    if (field.defaultValue !== null) {
      field.defaultValue = validateSseTemplateFieldValue(
        field,
        field.defaultValue,
        `Default value for ${key}`,
      );
    }
    return field;
  });
}

export function validateSseParameterizedTemplate(
  template: SseParameterizedTemplate,
): void {
  if (template.retryMs !== null && template.retryMsTemplate !== null) {
    throw new Error("Use either a fixed retry or a retry template, not both");
  }
  const definitions = new Map(
    template.fields.map((field) => [field.key, field]),
  );
  const used = new Set<string>();
  const sources: Array<[string, string | null]> = [
    ["Event name", template.eventName],
    ["Event data", template.data],
    ["Event ID", template.eventId],
    ["Retry template", template.retryMsTemplate],
  ];
  for (const [label, source] of sources) {
    if (source === null) continue;
    for (const placeholder of placeholders(source, label)) {
      if (!definitions.has(placeholder.key)) {
        throw new Error(
          `${label} references undeclared template field ${placeholder.key}`,
        );
      }
      used.add(placeholder.key);
    }
  }
  for (const field of template.fields) {
    if (!used.has(field.key)) {
      throw new Error(`Template field ${field.key} is not used by the event`);
    }
  }
}

export function normalizeSseTemplateValues(
  fields: SseMockTemplateField[],
  values: SseMockTemplateValue[] | null | undefined,
  requireResolved = true,
): SseMockTemplateValue[] {
  const definitions = new Map(fields.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const normalized = (values ?? []).map((value) => {
    const field = definitions.get(value.fieldId);
    if (!field) throw new Error(`Unknown template field ID ${value.fieldId}`);
    if (seen.has(value.fieldId)) {
      throw new Error(`Template field ${field.key} has more than one value`);
    }
    seen.add(value.fieldId);
    return {
      fieldId: value.fieldId,
      value: validateSseTemplateFieldValue(field, value.value),
    };
  });
  if (requireResolved) {
    for (const field of fields) {
      if (
        field.required &&
        !seen.has(field.id) &&
        field.defaultValue === null
      ) {
        throw new Error(`Required template field ${field.key} needs a value`);
      }
    }
  }
  return normalized;
}

function jsonValue(field: SseMockTemplateField, value: string): string {
  if (field.type === "TEXT") return JSON.stringify(value);
  if (field.type === "JSON") return JSON.stringify(JSON.parse(value));
  return value;
}

function renderSource(
  source: string,
  label: string,
  fields: Map<string, SseMockTemplateField>,
  values: Map<string, string>,
): string {
  const tokens = placeholders(source, label);
  let cursor = 0;
  let output = "";
  for (const token of tokens) {
    output += source.slice(cursor, token.start).replaceAll("\\{{", "{{");
    const field = fields.get(token.key);
    if (!field)
      throw new Error(`${label} references undeclared field ${token.key}`);
    const resolvedValue = values.has(field.id)
      ? values.get(field.id)
      : field.defaultValue;
    const value = resolvedValue ?? "";
    output +=
      token.json && resolvedValue === null
        ? JSON.stringify("")
        : token.json
          ? jsonValue(field, value)
          : value;
    cursor = token.end;
  }
  output += source.slice(cursor).replaceAll("\\{{", "{{");
  return output;
}

export function renderSseParameterizedTemplate(
  template: SseParameterizedTemplate,
  inputValues: SseMockTemplateValue[] | null | undefined,
): SseEvent {
  validateSseParameterizedTemplate(template);
  const normalized = normalizeSseTemplateValues(
    template.fields,
    inputValues,
    true,
  );
  const fields = new Map(template.fields.map((field) => [field.key, field]));
  const values = new Map(
    normalized.map((value) => [value.fieldId, value.value]),
  );
  const retryText =
    template.retryMsTemplate === null
      ? null
      : renderSource(
          template.retryMsTemplate,
          "Retry template",
          fields,
          values,
        );
  let retry = template.retryMs;
  if (retryText !== null) {
    if (!/^\d+$/.test(retryText)) {
      throw new Error(
        "Resolved retry must be an integer between 0 and 86400000",
      );
    }
    retry = Number(retryText);
    if (!Number.isSafeInteger(retry) || retry > MAX_RETRY_MS) {
      throw new Error(
        "Resolved retry must be an integer between 0 and 86400000",
      );
    }
  }
  return {
    event:
      template.eventName === null
        ? null
        : renderSource(template.eventName, "Event name", fields, values),
    data: renderSource(template.data, "Event data", fields, values),
    id:
      template.eventId === null
        ? null
        : renderSource(template.eventId, "Event ID", fields, values),
    retry,
  };
}
