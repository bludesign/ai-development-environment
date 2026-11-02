import { describe, expect, test } from "vitest";
import {
  resolveTransitionFields,
  type JiraTransitionField,
} from "./transition-fields";

const resolution: JiraTransitionField = {
  id: "resolution",
  name: "Resolution",
  required: true,
  allowedValues: [
    { id: "1", name: "Fixed" },
    { id: "2", name: "Done" },
  ],
};
describe("Jira transition field defaults", () => {
  test("prefers a declared Jira default to the project fallback", () => {
    expect(
      resolveTransitionFields(
        [{ ...resolution, defaultValue: { id: "1" } }],
        "2",
      ),
    ).toEqual({ values: { resolution: { id: "1" } }, unresolved: [] });
  });
  test("uses a valid configured Resolution only when the declared default is absent or unavailable", () => {
    for (const defaultValue of [undefined, "", { id: "removed" }]) {
      expect(
        resolveTransitionFields([{ ...resolution, defaultValue }], "2"),
      ).toEqual({ values: { resolution: { id: "2" } }, unresolved: [] });
    }
  });
  test("rejects an unavailable Resolution and leaves other unsupported required fields unresolved", () => {
    expect(
      resolveTransitionFields(
        [
          resolution,
          {
            id: "customfield_1",
            name: "Approval reason",
            required: true,
            allowedValues: [],
          },
        ],
        "removed",
      ),
    ).toEqual({ values: {}, unresolved: ["Resolution", "Approval reason"] });
  });
  test("supplies declared scalar defaults without inventing values for optional fields", () => {
    expect(
      resolveTransitionFields([
        {
          id: "count",
          name: "Count",
          required: true,
          defaultValue: 0,
          allowedValues: [],
        },
        {
          id: "optional",
          name: "Optional",
          required: false,
          defaultValue: "value",
          allowedValues: [],
        },
      ]),
    ).toEqual({ values: { count: 0 }, unresolved: [] });
  });
});
