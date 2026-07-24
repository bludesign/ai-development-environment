import { describe, expect, test } from "vitest";

import {
  evaluateWorkflowCondition,
  getSessionValue,
  interpolateWorkflowText,
  mergeSessionData,
  resolveWorkflowValue,
  setSessionValue,
} from "./session";

describe("workflow session data", () => {
  test("applies immutable nested patches and stable array paths", () => {
    const source = { ticket: { key: "AIDE-1" }, items: [{ value: 1 }] };
    const updated = setSessionValue(source, "items[0].value", 2);
    expect(getSessionValue(source, "items[0].value")).toBe(1);
    expect(getSessionValue(updated, "items[0].value")).toBe(2);
    expect(mergeSessionData(updated, { ticket: { status: "Done" } })).toEqual({
      ticket: { key: "AIDE-1", status: "Done" },
      items: [{ value: 2 }],
    });
  });

  test("resolves typed bindings and validated interpolation", () => {
    const data = { ticket: { key: "AIDE-2" }, count: 3 };
    expect(
      resolveWorkflowValue({ source: "SESSION", path: "count" }, data),
    ).toBe(3);
    expect(
      resolveWorkflowValue({ source: "LITERAL", value: false }, data),
    ).toBe(false);
    expect(
      interpolateWorkflowText("Fix {{ticket.key}} ({{count}})", data),
    ).toBe("Fix AIDE-2 (3)");
    expect(
      resolveWorkflowValue(
        { body: "Fix {{ticket.key}}", retries: ["{{count}}"] },
        data,
      ),
    ).toEqual({ body: "Fix AIDE-2", retries: ["3"] });
  });

  test("evaluates nested boolean trees, containment, and regex", () => {
    const data = { build: { failed: 2 }, labels: ["ready", "ios"] };
    expect(
      evaluateWorkflowCondition(
        {
          op: "ALL",
          conditions: [
            {
              op: "GTE",
              left: { source: "SESSION", path: "build.failed" },
              right: 2,
            },
            {
              op: "CONTAINS",
              left: { source: "SESSION", path: "labels" },
              right: "ready",
            },
            {
              op: "NOT",
              condition: {
                op: "MATCHES",
                left: { source: "SESSION", path: "labels[1]" },
                right: "android",
              },
            },
          ],
        },
        data,
      ),
    ).toBe(true);
  });
});
