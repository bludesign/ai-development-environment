import { describe, expect, test } from "vitest";

import {
  conditionValueText,
  parseConditionDraft,
  parseConditionValue,
  serializeConditionDraft,
} from "./condition";

describe("workflow condition builder", () => {
  test("round-trips a lone comparison without wrapping it in a group", () => {
    const stored = {
      op: "CONTAINS",
      left: { source: "SESSION", path: "pr.labels" },
      right: "ready",
    };

    const draft = parseConditionDraft(stored);

    expect(draft).toEqual({
      mode: "ALL",
      rows: [{ path: "pr.labels", operator: "CONTAINS", value: "ready" }],
    });
    expect(serializeConditionDraft(draft!)).toEqual(stored);
  });

  test("reads a negated comparison as its own operator", () => {
    const stored = {
      op: "NOT",
      condition: {
        op: "EXISTS",
        left: { source: "SESSION", path: "build.error" },
      },
    };

    const draft = parseConditionDraft(stored);

    expect(draft?.rows).toEqual([
      { path: "build.error", operator: "NOT_EXISTS", value: undefined },
    ]);
    // EXISTS compares against nothing, so no `right` is written back.
    expect(serializeConditionDraft(draft!)).toEqual(stored);
  });

  test("groups several rows and clears the field when there are none", () => {
    const draft = {
      mode: "ANY" as const,
      rows: [
        { path: "build.failed", operator: "GTE" as const, value: 2 },
        {
          path: "pr.author",
          operator: "EQ" as const,
          value: { source: "SESSION", path: "ticket.assignee" },
        },
      ],
    };

    const stored = serializeConditionDraft(draft);

    expect(stored).toEqual({
      op: "ANY",
      conditions: [
        {
          op: "GTE",
          left: { source: "SESSION", path: "build.failed" },
          right: 2,
        },
        {
          op: "EQ",
          left: { source: "SESSION", path: "pr.author" },
          right: { source: "SESSION", path: "ticket.assignee" },
        },
      ],
    });
    expect(parseConditionDraft(stored)).toEqual(draft);
    expect(serializeConditionDraft({ mode: "ALL", rows: [] })).toBeUndefined();
  });

  test("declines conditions the rows cannot represent", () => {
    expect(
      parseConditionDraft({
        op: "ALL",
        conditions: [
          { op: "ANY", conditions: [] },
          { op: "EQ", left: { source: "SESSION", path: "a" }, right: 1 },
        ],
      }),
    ).toBeNull();
    expect(parseConditionDraft({ op: "EQ", left: "literal", right: 1 })).toBe(
      null,
    );
    expect(parseConditionDraft(undefined)).toEqual({ mode: "ALL", rows: [] });
  });

  test("types compared values and quotes text that reads as one", () => {
    expect(parseConditionValue("2")).toBe(2);
    expect(parseConditionValue("true")).toBe(true);
    expect(parseConditionValue("ready")).toBe("ready");
    expect(parseConditionValue('"2"')).toBe("2");

    expect(conditionValueText(2)).toBe("2");
    expect(conditionValueText("ready")).toBe("ready");
    expect(conditionValueText("2")).toBe('"2"');
    expect(conditionValueText(undefined)).toBe("");
  });
});
