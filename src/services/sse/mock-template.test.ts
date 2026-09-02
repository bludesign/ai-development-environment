import { describe, expect, test } from "vitest";

import {
  normalizeSseTemplateFields,
  normalizeSseTemplateValues,
  renderSseParameterizedTemplate,
  validateSseParameterizedTemplate,
} from "./mock-template";

const fields = normalizeSseTemplateFields([
  {
    id: "name-id",
    key: "name",
    label: "Name",
    helpText: "",
    type: "TEXT",
    required: true,
    defaultValue: null,
  },
  {
    id: "count-id",
    key: "count",
    label: "Count",
    helpText: "",
    type: "NUMBER",
    required: false,
    defaultValue: "2",
  },
  {
    id: "enabled-id",
    key: "enabled",
    label: "Enabled",
    helpText: "",
    type: "BOOLEAN",
    required: false,
    defaultValue: "true",
  },
  {
    id: "metadata-id",
    key: "metadata",
    label: "Metadata",
    helpText: "",
    type: "JSON",
    required: false,
    defaultValue: '{"source":"default"}',
  },
]);

describe("parameterized SSE templates", () => {
  test("substitutes raw and JSON-safe typed values in every event field", () => {
    const event = renderSseParameterizedTemplate(
      {
        eventName: "update_{{name}}",
        data: '{"name":{{json:name}},"count":{{json:count}},"enabled":{{json:enabled}},"metadata":{{json:metadata}}}',
        eventId: "{{name}}-{{count}}",
        retryMs: null,
        retryMsTemplate: "{{count}}000",
        fields,
      },
      [
        { fieldId: "name-id", value: 'Ada\n"Lovelace"' },
        { fieldId: "count-id", value: "15" },
        { fieldId: "enabled-id", value: "false" },
        { fieldId: "metadata-id", value: '{"source":"override"}' },
      ],
    );

    expect(event).toEqual({
      event: 'update_Ada\n"Lovelace"',
      data: '{"name":"Ada\\n\\"Lovelace\\"","count":15,"enabled":false,"metadata":{"source":"override"}}',
      id: 'Ada\n"Lovelace"-15',
      retry: 15_000,
    });
  });

  test("uses defaults, optional empty strings, and escaped opening tokens", () => {
    const optionalFields = normalizeSseTemplateFields([
      fields[1]!,
      {
        id: "note-id",
        key: "note",
        label: "Note",
        helpText: "",
        type: "TEXT" as const,
        required: false,
        defaultValue: null,
      },
      {
        id: "optional-json-id",
        key: "optionalJson",
        label: "Optional JSON",
        helpText: "",
        type: "JSON" as const,
        required: false,
        defaultValue: null,
      },
    ]);
    expect(
      renderSseParameterizedTemplate(
        {
          eventName: null,
          data: String.raw`\{{name}} {{note}} {{count}} {{json:optionalJson}}`,
          eventId: null,
          retryMs: 100,
          retryMsTemplate: null,
          fields: optionalFields,
        },
        [],
      ).data,
    ).toBe('{{name}}  2 ""');
  });

  test.each([
    ["NUMBER", "NaN", "finite number"],
    ["NUMBER", "Infinity", "finite number"],
    ["BOOLEAN", "TRUE", "exactly true or false"],
    ["JSON", "{bad", "valid JSON"],
  ] as const)("rejects invalid %s values", (type, value, error) => {
    const typed = normalizeSseTemplateFields([
      {
        id: "typed-id",
        key: "typed",
        label: "Typed",
        helpText: "",
        type,
        required: true,
        defaultValue: null,
      },
    ]);
    expect(() =>
      normalizeSseTemplateValues(typed, [{ fieldId: "typed-id", value }], true),
    ).toThrow(error);
  });

  test("rejects undeclared placeholders, unused fields, and invalid retry output", () => {
    expect(() =>
      validateSseParameterizedTemplate({
        eventName: null,
        data: "{{missing}}",
        eventId: null,
        retryMs: null,
        retryMsTemplate: null,
        fields: [],
      }),
    ).toThrow("undeclared");
    expect(() =>
      validateSseParameterizedTemplate({
        eventName: null,
        data: "constant",
        eventId: null,
        retryMs: null,
        retryMsTemplate: null,
        fields: [fields[0]!],
      }),
    ).toThrow("not used");
    expect(() =>
      renderSseParameterizedTemplate(
        {
          eventName: null,
          data: "{{name}}",
          eventId: null,
          retryMs: null,
          retryMsTemplate: "{{name}}",
          fields: [fields[0]!],
        },
        [{ fieldId: "name-id", value: "not-an-integer" }],
      ),
    ).toThrow("Resolved retry");
  });

  test("keeps independent values for repeated template blocks", () => {
    const template = {
      eventName: "person",
      data: "{{name}}",
      eventId: null,
      retryMs: null,
      retryMsTemplate: null,
      fields: [fields[0]!],
    };
    expect(
      ["Ada", "Grace"].map(
        (value) =>
          renderSseParameterizedTemplate(template, [
            { fieldId: "name-id", value },
          ]).data,
      ),
    ).toEqual(["Ada", "Grace"]);
  });
});
