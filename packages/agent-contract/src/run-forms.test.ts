import { describe, expect, test } from "vitest";
import {
  parseRunQuestionField,
  runFormAnswers,
  RunFormError,
  type RunQuestionField,
} from "./run-forms";

const envelope = (values: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { value }]),
  );
describe("native run forms", () => {
  test("keeps zero, false, option values, defaults, and custom selections typed", () => {
    const fields: RunQuestionField[] = [
      { key: "count", type: "integer", default: 0 },
      { key: "enabled", type: "boolean", required: true },
      {
        key: "name",
        type: "string",
        options: [{ value: "id", label: "Friendly label" }],
      },
      { key: "list", type: "multiselect", options: [], custom: true },
      {
        key: "secretDefault",
        type: "string",
        hidden: true,
        default: "default",
      },
    ];
    expect(
      runFormAnswers(
        fields,
        envelope({
          enabled: false,
          name: "id",
          list: ["custom"],
          count: 0,
          secretDefault: "default",
        }),
      ),
    ).toEqual({
      count: 0,
      enabled: false,
      name: "id",
      list: ["custom"],
      secretDefault: "default",
    });
    expect(() =>
      runFormAnswers(fields, envelope({ enabled: "false", name: "id" })),
    ).toThrow(RunFormError);
  });
  test("evaluates dependent conditions in order, including array membership and unanswered neq", () => {
    const fields: RunQuestionField[] = [
      {
        key: "choose",
        type: "multiselect",
        options: [{ value: "yes", label: "Yes" }],
      },
      {
        key: "detail",
        type: "string",
        required: true,
        when: [{ key: "choose", op: "eq", value: "yes" }],
      },
      {
        key: "other",
        type: "string",
        required: true,
        when: [{ key: "detail", op: "neq", value: "skip" }],
      },
    ];
    expect(runFormAnswers(fields, {})).toEqual({});
    expect(runFormAnswers(fields, envelope({ choose: [] }))).toEqual({
      choose: [],
    });
    expect(() => runFormAnswers(fields, envelope({ choose: ["yes"] }))).toThrow(
      "required",
    );
    expect(
      runFormAnswers(fields, envelope({ choose: ["yes"], detail: "skip" })),
    ).toEqual({ choose: ["yes"], detail: "skip" });
    expect(() =>
      runFormAnswers(fields, envelope({ detail: "inactive" })),
    ).toThrow("inactive");
  });
  test.each([
    [{ key: "x", type: "integer" }, 1.5, "type"],
    [{ key: "x", type: "number", minimum: 2 }, 1, "minimum"],
    [{ key: "x", type: "number", maximum: 2 }, 3, "maximum"],
    [{ key: "x", type: "number" }, NaN, "type"],
    [{ key: "x", type: "string", minLength: 2 }, "a", "minLength"],
    [{ key: "x", type: "string", maxLength: 2 }, "abc", "maxLength"],
    [{ key: "x", type: "string", pattern: "^a$" }, "b", "pattern"],
    [{ key: "x", type: "string", format: "email" }, "invalid", "format"],
    [{ key: "x", type: "string", format: "uri" }, "/relative", "format"],
    [{ key: "x", type: "string", format: "date" }, "2026-02-30", "format"],
    [{ key: "x", type: "string", format: "date-time" }, "invalid", "format"],
    [
      { key: "x", type: "string", options: [{ value: "id", label: "Label" }] },
      "Label",
      "option",
    ],
    [
      { key: "x", type: "multiselect", options: [], minItems: 1 },
      [],
      "minItems",
    ],
    [
      { key: "x", type: "multiselect", options: [], custom: true, maxItems: 1 },
      ["a", "b"],
      "maxItems",
    ],
    [
      { key: "x", type: "external", url: "https://example.test" },
      false,
      "external",
    ],
  ])("rejects invalid %j answers", (field, value, code) => {
    expect(() =>
      runFormAnswers([field as RunQuestionField], envelope({ x: value })),
    ).toThrow(code);
  });
  test("requires separate external acknowledgement", () => {
    const fields: RunQuestionField[] = [
      { key: "external", type: "external", url: "https://example.test" },
    ];
    expect(() => runFormAnswers(fields, {})).toThrow("external");
    expect(runFormAnswers(fields, envelope({ external: true }))).toEqual({
      external: true,
    });
  });
  test("validates definitions and unknown answers", () => {
    expect(() =>
      parseRunQuestionField({
        key: "url",
        type: "external",
        url: "javascript:alert(1)",
      }),
    ).toThrow();
    expect(() =>
      parseRunQuestionField({ key: "n", type: "integer", default: 1.5 }),
    ).toThrow();
    expect(() =>
      runFormAnswers([{ key: "a", type: "string" }], envelope({ other: "x" })),
    ).toThrow("unknown");
    expect(() =>
      runFormAnswers(
        [
          {
            key: "a",
            type: "string",
            when: [{ key: "later", op: "eq", value: "x" }],
          },
        ],
        {},
      ),
    ).toThrow("earlier");
  });
});
