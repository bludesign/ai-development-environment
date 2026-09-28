import "server-only";

import { compileRe2 } from "@/lib/re2.server";
import { commandOutputPattern } from "./command-output-match";
import { compileCommandOutputPattern } from "./command-output-match.server";
import type { WorkflowDefinition, WorkflowDiagnostic } from "./definition";

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function staticRegexPattern(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = recordValue(value);
  return record.source === "LITERAL" && typeof record.value === "string"
    ? record.value
    : null;
}

function validateConditionPatterns(condition: unknown): void {
  const value = recordValue(condition);
  if (value.op === "ALL" || value.op === "ANY") {
    if (Array.isArray(value.conditions)) {
      for (const entry of value.conditions) validateConditionPatterns(entry);
    }
    return;
  }
  if (value.op === "NOT") {
    validateConditionPatterns(value.condition);
    return;
  }
  if (value.op !== "MATCHES") return;
  const pattern = staticRegexPattern(value.right);
  if (pattern !== null) {
    compileRe2(pattern, { label: "Workflow condition pattern" });
  }
}

/** Compile authored static patterns with the same engine used by workflow execution. */
export function validateWorkflowPatterns(
  definition: WorkflowDefinition,
  existingDiagnostics: readonly WorkflowDiagnostic[] = [],
): WorkflowDiagnostic[] {
  const diagnostics = [...existingDiagnostics];
  for (const node of definition.nodes) {
    if (node.kind === "SAVED_COMMAND" || node.kind === "CUSTOM_COMMAND") {
      const pattern = commandOutputPattern(node.config);
      if (pattern) {
        try {
          compileCommandOutputPattern(pattern);
        } catch (error) {
          if (
            !diagnostics.some(
              ({ code, nodeId }) =>
                code === "COMMAND_MATCH_PATTERN_INVALID" && nodeId === node.id,
            )
          ) {
            diagnostics.push({
              severity: "ERROR",
              code: "COMMAND_MATCH_PATTERN_INVALID",
              message: error instanceof Error ? error.message : String(error),
              nodeId: node.id,
            });
          }
        }
      }
    }
    try {
      validateConditionPatterns(node.config.condition);
    } catch (error) {
      diagnostics.push({
        severity: "ERROR",
        code: "WORKFLOW_REGEX_PATTERN_INVALID",
        message: error instanceof Error ? error.message : String(error),
        nodeId: node.id,
      });
    }
  }
  for (const trigger of definition.triggers) {
    const pattern =
      trigger.kind === "GITHUB_ISSUE_COMMAND" ||
      trigger.kind === "JIRA_ISSUE_COMMAND"
        ? trigger.config.commandPattern
        : trigger.kind === "COMMAND_OUTPUT_MATCH"
          ? trigger.config.outputPattern
          : null;
    if (typeof pattern !== "string") continue;
    try {
      compileRe2(pattern, {
        label:
          trigger.kind === "COMMAND_OUTPUT_MATCH"
            ? "Command output trigger pattern"
            : "Issue command pattern",
      });
    } catch (error) {
      if (
        !diagnostics.some(
          ({ code, triggerId }) =>
            code === "WORKFLOW_REGEX_PATTERN_INVALID" &&
            triggerId === trigger.id,
        )
      ) {
        diagnostics.push({
          severity: "ERROR",
          code: "WORKFLOW_REGEX_PATTERN_INVALID",
          message: error instanceof Error ? error.message : String(error),
          triggerId: trigger.id,
        });
      }
    }
  }
  return diagnostics.slice(existingDiagnostics.length);
}
