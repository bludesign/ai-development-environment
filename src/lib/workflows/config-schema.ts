/**
 * JSON Schema for the `config` object of every step and trigger kind, derived
 * from the field descriptors in `config-descriptors.ts`.
 *
 * The workflow catalog used to advertise `{ type: "object", additionalProperties:
 * true }` for all 115 kinds, which told a caller nothing about what a step
 * accepts. The editor already knew — it renders a typed control per field — so
 * this module projects that same knowledge into schemas the catalog can publish
 * over GraphQL and MCP. One source of truth: a key added to a descriptor shows
 * up in the form and in the schema at once.
 *
 * Schemas are advisory rather than enforced. `workflowNodeSchema` still accepts
 * any object as `config`, because adapters tolerate partial config and resolve
 * missing values at run time; these schemas describe what a kind *understands*.
 */

import type {
  ConfigFieldDescriptor,
  ConfigFieldScope,
  ConfigOptionSource,
} from "./config-descriptor-types";
import { getConfigDescriptor } from "./config-descriptors";
import { WORKFLOW_CHOICE_KEY_PATTERN } from "./kinds";

type JsonSchema = Record<string, unknown>;

/** The comparison operators `evaluateWorkflowCondition` understands. */
const CONDITION_LEAF_OPERATORS = [
  "EQ",
  "NE",
  "GT",
  "GTE",
  "LT",
  "LTE",
  "CONTAINS",
  "MATCHES",
  "EXISTS",
] as const;

/**
 * A config value written as a reference rather than a constant. `resolveWorkflowValue`
 * unwraps these at run time; `workflowValueSessionPaths` reads the same shapes
 * back out to decide what a step requires, so a binding that does not match
 * exactly is both unresolvable and invisible to the validator.
 */
const SESSION_BINDING_SCHEMA: JsonSchema = {
  type: "object",
  title: "Session binding",
  description:
    "Reads the value from run session data at `path` instead of hard-coding it.",
  properties: {
    source: { const: "SESSION" },
    path: {
      type: "string",
      description: "Dotted session path, e.g. `ticket.key` or `pr.number`.",
    },
  },
  required: ["source", "path"],
  additionalProperties: false,
};

const LITERAL_BINDING_SCHEMA: JsonSchema = {
  type: "object",
  title: "Literal wrapper",
  description:
    "An explicit constant. Equivalent to writing the value directly; the editor uses it to record that a field was pinned rather than bound.",
  properties: { source: { const: "LITERAL" }, value: {} },
  required: ["source"],
  additionalProperties: false,
};

/**
 * Widens a field's native schema to the other ways its value may be authored.
 * `session` adds the binding object; `interpolation` allows `{{path}}` tokens
 * inside a string, which is a plain string as far as the schema is concerned but
 * worth calling out in the description.
 *
 * Annotations stay on the wrapper rather than sinking into `anyOf[0]`, so a
 * reader sees the description and examples without unwrapping the union.
 */
function withValueModes(
  base: JsonSchema,
  annotations: JsonSchema,
  field: ConfigFieldDescriptor,
): JsonSchema {
  const modes = field.valueModes ?? [];
  const notes = [
    modes.includes("session") ? "May also be a session binding." : null,
    modes.includes("interpolation")
      ? "Strings here — including strings nested inside the value — may carry `{{path}}` interpolation tokens, e.g. `{{worktree.baseBranch}}`."
      : null,
  ].filter(Boolean);
  const described = notes.length
    ? {
        ...annotations,
        description: [annotations.description, ...notes]
          .filter(Boolean)
          .join(" "),
      }
    : annotations;
  if (!modes.includes("session")) return { ...base, ...described };
  return {
    anyOf: [base, SESSION_BINDING_SCHEMA, LITERAL_BINDING_SCHEMA],
    ...described,
  };
}

/** Prose describing where a data-driven field's options come from. */
function optionSourceDescription(source: ConfigOptionSource): string | null {
  if (source.kind === "static") {
    const labelled = source.options.filter(({ label }) => label);
    return labelled.length
      ? labelled.map(({ value, label }) => `\`${value}\` — ${label}`).join("; ")
      : null;
  }
  const scoped = source.scopeFrom
    ? ` Scoped by the sibling \`${source.scopeFrom}\` value.`
    : "";
  const path = source.sessionPath
    ? ` Usually bound to \`${source.sessionPath}\`.`
    : "";
  return `Identifier of a ${source.resource} known to the control plane.${path}${scoped}`;
}

function baseSchema(field: ConfigFieldDescriptor): JsonSchema {
  switch (field.control) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "enum": {
      const source = field.options;
      if (source?.kind === "static") {
        return {
          type: "string",
          enum: source.options.map(({ value }) => value),
        };
      }
      return { type: "string" };
    }
    case "resource":
      return { type: "string" };
    case "resourceMulti":
    case "stringList":
    case "mcpPresetMulti":
      return { type: "array", items: { type: "string" } };
    case "record":
      return {
        type: "object",
        additionalProperties:
          field.recordValueType === "json" ? {} : { type: "string" },
      };
    case "condition":
      return { $ref: "#/$defs/condition" };
    case "choiceOptions":
      return {
        type: "array",
        description: "Buttons offered to the person answering.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            description: { type: "string" },
          },
          required: ["label"],
          additionalProperties: false,
        },
      };
    case "triggerChoices":
      return {
        type: "array",
        minItems: 1,
        description:
          "Options this trigger offers. Each `key` names an outgoing handle on the trigger, so edges stay attached when a label is renamed.",
        items: {
          type: "object",
          properties: {
            key: {
              type: "string",
              pattern: WORKFLOW_CHOICE_KEY_PATTERN.source,
            },
            label: { type: "string" },
            description: { type: "string" },
          },
          required: ["key", "label"],
          additionalProperties: false,
        },
      };
    case "json":
      return {};
    case "model":
      // Handled by `modelFields` — the control spans three sibling keys.
      return { type: "string" };
    case "text":
    default:
      return { type: "string" };
  }
}

/** Assembles one field's schema, folding in help text, examples, and value modes. */
function fieldSchema(field: ConfigFieldDescriptor): JsonSchema {
  const optionHelp = field.options
    ? optionSourceDescription(field.options)
    : null;
  const annotations: JsonSchema = {
    description: [field.label, field.help, optionHelp]
      .filter(Boolean)
      .join(" — "),
  };
  if (field.placeholder) annotations.examples = [field.placeholder];
  if (field.default !== undefined) annotations.default = field.default;
  return withValueModes(baseSchema(field), annotations, field);
}

/**
 * The `model` control edits provider, model, and effort together, so it
 * contributes three properties rather than one. `key` is the primary `model`
 * slot; `modelKeys` names all three.
 */
function modelFields(
  field: ConfigFieldDescriptor,
): Array<[string, JsonSchema]> {
  const keys = field.modelKeys;
  if (!keys) return [[field.key, fieldSchema(field)]];
  const entry = (key: string, description: string): [string, JsonSchema] => [
    key,
    withValueModes({ type: "string" }, { description }, field),
  ];
  return [
    entry(keys.provider, "AI provider that serves the model."),
    entry(keys.model, "Model identifier, as listed by the provider catalog."),
    entry(keys.effort, "Reasoning effort, when the model supports it."),
  ];
}

/**
 * The `config` schema for one kind. Kinds with no descriptor fall back to an
 * open object — the same contract the catalog gave every kind before.
 */
export function configSchemaForKind(
  kind: string,
  scope: ConfigFieldScope,
): JsonSchema {
  const descriptor = getConfigDescriptor(kind, scope);
  if (!descriptor) return { type: "object", additionalProperties: true };

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  let usesCondition = false;
  for (const field of descriptor.fields) {
    if (field.control === "condition") usesCondition = true;
    const entries =
      field.control === "model"
        ? modelFields(field)
        : ([[field.key, fieldSchema(field)]] as Array<[string, JsonSchema]>);
    for (const [key, schema] of entries) properties[key] = schema;
    if (field.required) required.push(field.key);
  }

  const schema: JsonSchema = {
    type: "object",
    properties,
    // Adapters read only the keys they know, and the editor keeps a raw-JSON
    // escape hatch for anything not described here, so extra keys are tolerated.
    additionalProperties: true,
  };
  if (required.length) schema.required = required;
  if (usesCondition) schema.$defs = { condition: conditionSchema() };
  return schema;
}

/** Recursive schema for the condition tree `evaluateWorkflowCondition` walks. */
function conditionSchema(): JsonSchema {
  return {
    type: "object",
    description:
      "A condition tree. `ALL`/`ANY` combine nested conditions, `NOT` negates one, and the comparison operators test `left` against `right`.",
    anyOf: [
      {
        properties: {
          op: { enum: ["ALL", "ANY"] },
          conditions: { type: "array", items: { $ref: "#/$defs/condition" } },
        },
        required: ["op", "conditions"],
      },
      {
        properties: {
          op: { const: "NOT" },
          condition: { $ref: "#/$defs/condition" },
        },
        required: ["op", "condition"],
      },
      {
        properties: {
          op: { enum: [...CONDITION_LEAF_OPERATORS] },
          left: {
            description:
              "Value to test — usually a session binding. `EXISTS` needs only this side.",
          },
          right: { description: "Value to compare against." },
        },
        required: ["op", "left"],
      },
    ],
  };
}
