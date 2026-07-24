export type SessionData = Record<string, unknown>;

const SEGMENT = /^([A-Za-z0-9_-]+)(?:\[(\d+)\])?$/;
const SESSION_VALUE_PATH =
  /^[A-Za-z0-9_-]+(?:\[\d+\])?(?:\.[A-Za-z0-9_-]+(?:\[\d+\])?)*$/;
const INTERPOLATION =
  /\{\{\s*([A-Za-z0-9_-]+(?:\[\d+\])?(?:\.[A-Za-z0-9_-]+(?:\[\d+\])?)*)\s*\}\}/g;
const INTERPOLATION_TOKEN = /\{\{([^{}]*)\}\}/g;

export function sessionPathSegments(path: string): Array<string | number> {
  return path.split(".").flatMap((part) => {
    const match = SEGMENT.exec(part);
    if (!match) throw new Error(`Invalid session path: ${path}`);
    return match[2] === undefined ? [match[1]!] : [match[1]!, Number(match[2])];
  });
}

export function getSessionValue(data: unknown, path: string): unknown {
  let current = data;
  for (const segment of sessionPathSegments(path)) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (typeof current !== "object" || Array.isArray(current))
        return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

export function hasSessionValue(data: unknown, path: string): boolean {
  return getSessionValue(data, path) !== undefined;
}

export function setSessionValue(
  data: SessionData,
  path: string,
  value: unknown,
): SessionData {
  const root = structuredClone(data);
  const segments = sessionPathSegments(path);
  let current: Record<string, unknown> | unknown[] = root;
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (last) {
      if (typeof segment === "number") {
        if (!Array.isArray(current))
          throw new Error(`Expected an array at ${path}`);
        current[segment] = value;
      } else {
        if (Array.isArray(current))
          throw new Error(`Expected an object at ${path}`);
        current[segment] = value;
      }
      return;
    }
    const nextIsIndex = typeof segments[index + 1] === "number";
    if (typeof segment === "number") {
      if (!Array.isArray(current))
        throw new Error(`Expected an array at ${path}`);
      const child = current[segment];
      if (!child || typeof child !== "object")
        current[segment] = nextIsIndex ? [] : {};
      current = current[segment] as Record<string, unknown> | unknown[];
    } else {
      if (Array.isArray(current))
        throw new Error(`Expected an object at ${path}`);
      const child = current[segment];
      if (!child || typeof child !== "object")
        current[segment] = nextIsIndex ? [] : {};
      current = current[segment] as Record<string, unknown> | unknown[];
    }
  });
  return root;
}

export function mergeSessionData(
  data: SessionData,
  patch: SessionData,
): SessionData {
  const merge = (left: unknown, right: unknown): unknown => {
    if (
      left &&
      right &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const result = { ...(left as Record<string, unknown>) };
      for (const [key, value] of Object.entries(
        right as Record<string, unknown>,
      )) {
        result[key] = merge(result[key], value);
      }
      return result;
    }
    return structuredClone(right);
  };
  return merge(data, patch) as SessionData;
}

export function resolveWorkflowValue(
  value: unknown,
  data: SessionData,
): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).source === "SESSION" &&
    typeof (value as Record<string, unknown>).path === "string"
  ) {
    return getSessionValue(data, (value as { path: string }).path);
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).source === "LITERAL"
  ) {
    return (value as Record<string, unknown>).value;
  }
  if (Array.isArray(value))
    return value.map((entry) => resolveWorkflowValue(entry, data));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        resolveWorkflowValue(entry, data),
      ]),
    );
  }
  if (typeof value === "string") return interpolateWorkflowText(value, data);
  return value;
}

export function workflowValueSessionPaths(
  value: unknown,
  found = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) workflowValueSessionPaths(entry, found);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      record.source === "SESSION" &&
      typeof record.path === "string" &&
      SESSION_VALUE_PATH.test(record.path)
    ) {
      found.add(record.path);
    }
    for (const entry of Object.values(record))
      workflowValueSessionPaths(entry, found);
  } else if (typeof value === "string") {
    for (const match of value.matchAll(INTERPOLATION)) found.add(match[1]!);
  }
  return found;
}

export function invalidWorkflowValueBindings(
  value: unknown,
  errors: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) invalidWorkflowValueBindings(entry, errors);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      record.source === "SESSION" &&
      (typeof record.path !== "string" || !SESSION_VALUE_PATH.test(record.path))
    ) {
      errors.push("Session bindings require a valid dotted path");
    }
    for (const entry of Object.values(record))
      invalidWorkflowValueBindings(entry, errors);
  } else if (typeof value === "string" && /\{\{|\}\}/.test(value)) {
    const remaining = value.replace(INTERPOLATION_TOKEN, "");
    if (/\{\{|\}\}/.test(remaining))
      errors.push("Text interpolation contains unmatched braces");
    for (const match of value.matchAll(INTERPOLATION_TOKEN)) {
      if (!SESSION_VALUE_PATH.test(match[1]!.trim()))
        errors.push("Text interpolation requires a valid dotted path");
    }
  }
  return errors;
}

export function interpolateWorkflowText(
  template: string,
  data: SessionData,
): string {
  return template.replace(INTERPOLATION, (_match, path: string) => {
    const value = getSessionValue(data, path);
    if (value === null || value === undefined) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

export type WorkflowCondition =
  | { op: "ALL" | "ANY"; conditions: WorkflowCondition[] }
  | { op: "NOT"; condition: WorkflowCondition }
  | {
      op:
        | "EQ"
        | "NE"
        | "GT"
        | "GTE"
        | "LT"
        | "LTE"
        | "CONTAINS"
        | "MATCHES"
        | "EXISTS";
      left: unknown;
      right?: unknown;
    };

function comparable(value: unknown): string | number | boolean | null {
  return value === null ||
    ["string", "number", "boolean"].includes(typeof value)
    ? (value as string | number | boolean | null)
    : JSON.stringify(value);
}

export function evaluateWorkflowCondition(
  condition: WorkflowCondition,
  data: SessionData,
): boolean {
  if (condition.op === "ALL") {
    return condition.conditions.every((entry) =>
      evaluateWorkflowCondition(entry, data),
    );
  }
  if (condition.op === "ANY") {
    return condition.conditions.some((entry) =>
      evaluateWorkflowCondition(entry, data),
    );
  }
  if (condition.op === "NOT")
    return !evaluateWorkflowCondition(condition.condition, data);
  if (!("left" in condition)) return false;
  const left = resolveWorkflowValue(condition.left, data);
  const right = resolveWorkflowValue(condition.right, data);
  switch (condition.op) {
    case "EXISTS":
      return left !== undefined && left !== null;
    case "EQ":
      return JSON.stringify(left) === JSON.stringify(right);
    case "NE":
      return JSON.stringify(left) !== JSON.stringify(right);
    case "GT":
      return comparable(left)! > comparable(right)!;
    case "GTE":
      return comparable(left)! >= comparable(right)!;
    case "LT":
      return comparable(left)! < comparable(right)!;
    case "LTE":
      return comparable(left)! <= comparable(right)!;
    case "CONTAINS":
      return Array.isArray(left)
        ? left.some((entry) => JSON.stringify(entry) === JSON.stringify(right))
        : String(left ?? "").includes(String(right ?? ""));
    case "MATCHES":
      return new RegExp(String(right ?? "")).test(String(left ?? ""));
  }
}

export function workflowSessionData(value: string): SessionData {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workflow session data must be a JSON object");
  }
  return parsed as SessionData;
}
