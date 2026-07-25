import { describe, expect, test } from "vitest";

import { configSchemaForKind } from "./config-schema";
import { WORKFLOW_STEP_KINDS, WORKFLOW_TRIGGER_KINDS } from "./kinds";

type JsonSchema = Record<string, unknown>;

function properties(kind: string, scope: "step" | "trigger") {
  return configSchemaForKind(kind, scope).properties as Record<
    string,
    JsonSchema
  >;
}

/** Unwraps the value-mode `anyOf` to the native schema a field started from. */
function native(schema: JsonSchema): JsonSchema {
  const options = schema.anyOf as JsonSchema[] | undefined;
  return options ? options[0]! : schema;
}

describe("configSchemaForKind", () => {
  test("every step and trigger kind describes its config", () => {
    for (const kind of WORKFLOW_STEP_KINDS) {
      const schema = configSchemaForKind(kind, "step");
      expect(schema.type, kind).toBe("object");
      expect(schema.properties, kind).toBeDefined();
    }
    for (const kind of WORKFLOW_TRIGGER_KINDS) {
      const schema = configSchemaForKind(kind, "trigger");
      expect(schema.type, kind).toBe("object");
      expect(schema.properties, kind).toBeDefined();
    }
  });

  test("an unknown kind falls back to an open object", () => {
    expect(configSchemaForKind("NOT_A_KIND", "step")).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });

  test("required descriptors become required properties", () => {
    const schema = configSchemaForKind("JIRA_TRANSITION", "step");
    expect(schema.required).toContain("transitionId");
    // `issueKey` is optional — it falls back to `ticket.key` in session data.
    expect(schema.required).not.toContain("issueKey");
  });

  test("static enum options become an enum of their values", () => {
    const method = native(properties("GITHUB_MERGE_PR", "step").method!);
    expect(method.type).toBe("string");
    expect(method.enum).toEqual(["SQUASH", "MERGE", "REBASE"]);
  });

  test("list and record controls describe their element types", () => {
    const labels = properties("GITHUB_SET_PR_LABELS", "step").labels!;
    expect(labels).toMatchObject({ type: "array", items: { type: "string" } });
    const environment = properties("TERMINAL_RUN", "step").environment!;
    expect(environment).toMatchObject({
      type: "object",
      additionalProperties: { type: "string" },
    });
  });

  test("trigger filters accept JSON values without widening string records", () => {
    const filters = properties("GITHUB_PR_STATE", "trigger").filters!;
    expect(filters).toEqual({
      type: "object",
      additionalProperties: {},
      description: expect.any(String),
    });

    const environment = properties("TERMINAL_RUN", "step").environment!;
    expect(environment.additionalProperties).toEqual({ type: "string" });
  });

  test("fields that accept session data widen to the binding shapes", () => {
    const prompt = properties("RUN_CREATE_SESSION", "step").prompt!;
    const options = prompt.anyOf as JsonSchema[];
    expect(options[0]).toMatchObject({ type: "string" });
    expect(options[1]).toMatchObject({
      properties: { source: { const: "SESSION" } },
    });
    expect(options[2]).toMatchObject({
      properties: { source: { const: "LITERAL" } },
    });
    expect(prompt.description).toContain("interpolation");
  });

  test("interpolation-only fields keep their native shape but say so", () => {
    // No `anyOf`: a list is still a list, and only the strings inside it carry
    // tokens — but a caller reading the schema needs to be told that.
    const environment = properties("TERMINAL_RUN", "step").environment!;
    expect(environment.type).toBe("object");
    expect(environment.anyOf).toBeUndefined();
    expect(environment.description).toContain("{{worktree.baseBranch}}");
  });

  test("literal-only fields stay narrow", () => {
    // Booleans have no `valueModes`, so they must not gain the binding `anyOf`.
    expect(properties("JIRA_LOAD_TICKET", "step").force).toMatchObject({
      type: "boolean",
    });
  });

  test("the model control expands to its three sibling keys", () => {
    const fields = properties("RUN_CREATE_SESSION", "step");
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining(["provider", "model", "effort"]),
    );
  });

  test("conditions carry a recursive definition", () => {
    const schema = configSchemaForKind("CONTROL_IF", "step");
    const condition = (schema.properties as Record<string, JsonSchema>)
      .condition!;
    expect(condition.$ref).toBe("#/$defs/condition");
    expect(schema.$defs).toHaveProperty("condition");
  });

  test("choice triggers constrain option keys to the handle pattern", () => {
    const choices = properties("MANUAL_CHOICE", "trigger").choices!;
    const items = choices.items as JsonSchema;
    const itemProperties = items.properties as Record<string, JsonSchema>;
    expect(itemProperties.key!.pattern).toBe(
      "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
    );
    expect(items.required).toEqual(["key", "label"]);
  });

  test("placeholders surface as examples and help as description", () => {
    const issueKey = properties("JIRA_LOAD_TICKET", "step").issueKey!;
    expect(issueKey.examples).toEqual(["APP-123"]);
    const assignee = properties("JIRA_ASSIGN", "step").accountId!;
    expect(assignee.description).toContain("unassign");
  });

  test("issue command triggers advertise publishable required config", () => {
    const schema = configSchemaForKind("GITHUB_ISSUE_COMMAND", "trigger");
    expect(schema.required).toEqual(
      expect.arrayContaining(["allowedLogins", "commandPattern"]),
    );
    expect(
      properties("GITHUB_ISSUE_COMMAND", "trigger").commandPattern!.examples,
    ).toEqual(["^/deploy\\b$"]);
  });

  test("CONTROL_TRY describes an empty config rather than an opaque object", () => {
    const schema = configSchemaForKind("CONTROL_TRY", "step");
    expect(schema.properties).toEqual({});
    expect(schema.required).toBeUndefined();
  });
});
