import "server-only";

import { compileRe2 } from "@/lib/re2.server";
import {
  resolveWorkflowValue,
  type SessionData,
  type WorkflowCondition,
} from "@/lib/workflows/session";

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
      return compileRe2(String(right ?? ""), {
        label: "Workflow condition pattern",
      }).test(String(left ?? ""));
  }
}
