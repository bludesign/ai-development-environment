import { expect, test } from "vitest";

import { emptyWorkflowDefinition, parseWorkflowDefinition } from "./definition";
import { validateWorkflowPatterns } from "./validation.server";

const definition = (config: Record<string, unknown>, kind = "CUSTOM_COMMAND") =>
  parseWorkflowDefinition({
    ...emptyWorkflowDefinition(),
    nodes: [
      { id: "step", kind, name: "Step", position: { x: 0, y: 0 }, config },
    ],
  });

test("static output patterns must compile with RE2 and consume text", () => {
  for (const outputPattern of ["(?=ready)", "a*"])
    expect(validateWorkflowPatterns(definition({ outputPattern }))).toEqual([
      expect.objectContaining({
        code: "COMMAND_MATCH_PATTERN_INVALID",
        nodeId: "step",
      }),
    ]);
  expect(
    validateWorkflowPatterns(definition({ outputPattern: "(?P<state>ready)" })),
  ).toEqual([]);
});

test("condition validation follows nested literal patterns but leaves session bindings to runtime", () => {
  const conditions = [
    {
      op: "MATCHES",
      left: "ready",
      right: { source: "SESSION", path: "pattern" },
    },
    {
      op: "NOT",
      condition: {
        op: "MATCHES",
        left: "ready",
        right: { source: "LITERAL", value: "[" },
      },
    },
  ];
  expect(
    validateWorkflowPatterns(
      definition({ condition: { op: "ALL", conditions } }),
    ),
  ).toEqual([
    expect.objectContaining({
      code: "WORKFLOW_REGEX_PATTERN_INVALID",
      nodeId: "step",
    }),
  ]);
  expect(
    validateWorkflowPatterns(definition({ condition: conditions[0] })),
  ).toEqual([]);
});

test("issue and command-output triggers use authoritative regex validation without duplicate diagnostics", () => {
  const value = parseWorkflowDefinition({
    ...emptyWorkflowDefinition(),
    triggers: [
      {
        id: "issue",
        kind: "GITHUB_ISSUE_COMMAND",
        position: { x: 0, y: 0 },
        config: { commandPattern: "^($", allowedLogins: ["me"] },
      },
      {
        id: "output",
        kind: "COMMAND_OUTPUT_MATCH",
        position: { x: 0, y: 100 },
        config: { outputPattern: "[" },
      },
    ],
  });
  const diagnostics = validateWorkflowPatterns(value);
  expect(diagnostics.map(({ triggerId }) => triggerId)).toEqual([
    "issue",
    "output",
  ]);
  expect(validateWorkflowPatterns(value, diagnostics)).toEqual([]);
});
