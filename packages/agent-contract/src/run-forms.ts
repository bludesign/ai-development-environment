/** The native OpenCode 2 form contract, kept independent of its runtime SDK. */
export type RunFormValue = string | number | boolean | string[];
export type RunFormOption = {
  value: string;
  label: string;
  description?: string;
};
type FieldBase = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<{
    key: string;
    op: "eq" | "neq";
    value: string | number | boolean;
  }>;
};
export type RunQuestionField =
  | (FieldBase & {
      type: "string";
      format?: "email" | "uri" | "date" | "date-time";
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      placeholder?: string;
      default?: string;
      options?: RunFormOption[];
      custom?: boolean;
    })
  | (FieldBase & {
      type: "number" | "integer";
      minimum?: number;
      maximum?: number;
      default?: number;
    })
  | (FieldBase & { type: "boolean"; default?: boolean })
  | (FieldBase & {
      type: "multiselect";
      options: RunFormOption[];
      minItems?: number;
      maxItems?: number;
      custom?: boolean;
      default?: string[];
    })
  | {
      key: string;
      type: "external";
      url: string;
      title?: string;
      description?: string;
    };

export type RunFormErrorCode =
  | "required"
  | "type"
  | "minimum"
  | "maximum"
  | "minLength"
  | "maxLength"
  | "pattern"
  | "format"
  | "option"
  | "minItems"
  | "maxItems"
  | "inactive"
  | "unknown"
  | "external";
export class RunFormError extends Error {
  constructor(
    public readonly code: RunFormErrorCode,
    public readonly fieldKey: string,
  ) {
    super(`Invalid form answer (${code}): ${fieldKey}`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid form object");
  return value as Record<string, unknown>;
}

/** Validate provider-supplied field definitions before persisting or rendering them. */
export function parseRunQuestionField(value: unknown): RunQuestionField {
  const field = object(value);
  if (
    typeof field.key !== "string" ||
    !field.key ||
    ![
      "string",
      "number",
      "integer",
      "boolean",
      "multiselect",
      "external",
    ].includes(String(field.type))
  )
    throw new Error("Invalid form field");
  for (const key of ["title", "description", "pattern", "placeholder"])
    if (field[key] !== undefined && typeof field[key] !== "string")
      throw new Error(`Invalid form field ${key}`);
  for (const key of ["required", "hidden", "custom"])
    if (field[key] !== undefined && typeof field[key] !== "boolean")
      throw new Error(`Invalid form field ${key}`);
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"])
    if (
      field[key] !== undefined &&
      (typeof field[key] !== "number" ||
        !Number.isInteger(field[key]) ||
        field[key] < 0)
    )
      throw new Error(`Invalid form field ${key}`);
  for (const key of ["minimum", "maximum"])
    if (
      field[key] !== undefined &&
      (typeof field[key] !== "number" || !Number.isFinite(field[key]))
    )
      throw new Error(`Invalid form field ${key}`);
  if (
    field.format !== undefined &&
    !["email", "uri", "date", "date-time"].includes(String(field.format))
  )
    throw new Error("Invalid form field format");
  if (
    field.type === "external" &&
    (typeof field.url !== "string" ||
      !URL.canParse(field.url) ||
      !["https:", "http:"].includes(new URL(field.url).protocol))
  )
    throw new Error("Invalid external form URL");
  if (field.type === "multiselect" && !Array.isArray(field.options))
    throw new Error("Missing form options");
  if (field.options !== undefined) {
    if (!Array.isArray(field.options)) throw new Error("Invalid form options");
    const values = new Set<string>();
    for (const candidate of field.options) {
      const option = object(candidate);
      if (
        typeof option.value !== "string" ||
        typeof option.label !== "string" ||
        (option.description !== undefined &&
          typeof option.description !== "string") ||
        values.has(option.value)
      )
        throw new Error("Invalid form option");
      values.add(option.value);
    }
  }
  if (field.when !== undefined) {
    if (!Array.isArray(field.when)) throw new Error("Invalid form conditions");
    for (const candidate of field.when) {
      const condition = object(candidate);
      if (
        typeof condition.key !== "string" ||
        !["eq", "neq"].includes(String(condition.op)) ||
        !["string", "number", "boolean"].includes(typeof condition.value)
      )
        throw new Error("Invalid form condition");
    }
  }
  if (field.default !== undefined)
    validateRunFormValue(field as RunQuestionField, field.default);
  return field as RunQuestionField;
}

export function runFormFieldActive(
  field: RunQuestionField,
  answers: Record<string, RunFormValue>,
): boolean {
  if (field.type === "external" || !field.when) return true;
  return field.when.every((condition) => {
    const value = answers[condition.key];
    if (value === undefined) return false;
    const matches = Array.isArray(value)
      ? value.includes(String(condition.value))
      : value === condition.value;
    return condition.op === "eq" ? matches : !matches;
  });
}

export function validateRunFormValue(
  field: RunQuestionField,
  value: unknown,
): asserts value is RunFormValue {
  const fail = (code: RunFormErrorCode): never => {
    throw new RunFormError(code, field.key);
  };
  if (field.type === "external") {
    if (value !== true) fail("external");
    return;
  }
  if (value === undefined) {
    if (field.required) fail("required");
    return;
  }
  if (field.type === "string") {
    if (typeof value !== "string") return fail("type");
    if (field.required && !value.length) fail("required");
    if (field.minLength !== undefined && value.length < field.minLength)
      fail("minLength");
    if (field.maxLength !== undefined && value.length > field.maxLength)
      fail("maxLength");
    if (field.pattern !== undefined) {
      let matches = false;
      try {
        matches = new RegExp(field.pattern).test(value);
      } catch {
        /* Invalid patterns fail validation. */
      }
      if (!matches) fail("pattern");
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      fail("format");
    if (field.format === "uri" && !URL.canParse(value)) fail("format");
    if (
      field.format === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      fail("format");
    if (field.format === "date-time" && Number.isNaN(Date.parse(value)))
      fail("format");
    if (
      field.options &&
      !field.custom &&
      !field.options.some((option) => option.value === value)
    )
      fail("option");
  } else if (field.type === "number" || field.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (field.type === "integer" && !Number.isInteger(value))
    )
      return fail("type");
    if (field.minimum !== undefined && value < field.minimum) fail("minimum");
    if (field.maximum !== undefined && value > field.maximum) fail("maximum");
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean") fail("type");
  } else if (field.type === "multiselect") {
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string")
    )
      return fail("type");
    if (field.required && !value.length) fail("required");
    if (field.minItems !== undefined && value.length < field.minItems)
      fail("minItems");
    if (field.maxItems !== undefined && value.length > field.maxItems)
      fail("maxItems");
    if (
      !field.custom &&
      value.some(
        (item) => !field.options.some((option) => option.value === item),
      )
    )
      fail("option");
  }
}

/** Decode the persisted typed-answer envelope and validate it in native field order. */
export function runFormAnswers(
  fields: RunQuestionField[],
  input: unknown,
): Record<string, RunFormValue> {
  const envelope = object(input);
  const known = new Set(fields.map((field) => field.key));
  if (known.size !== fields.length) throw new Error("Duplicate form field key");
  for (const key of Object.keys(envelope))
    if (!known.has(key)) throw new RunFormError("unknown", key);
  const answers: Record<string, RunFormValue> = Object.create(null);
  const earlier = new Set<string>();
  for (const field of fields) {
    if (field.type !== "external")
      for (const condition of field.when ?? [])
        if (!earlier.has(condition.key))
          throw new Error("Form conditions must reference an earlier field");
    const supplied = Object.hasOwn(envelope, field.key);
    const value = supplied ? object(envelope[field.key]).value : undefined;
    if (!runFormFieldActive(field, answers)) {
      if (supplied) throw new RunFormError("inactive", field.key);
    } else {
      validateRunFormValue(field, value);
      if (value !== undefined) answers[field.key] = value;
    }
    earlier.add(field.key);
  }
  return answers;
}
