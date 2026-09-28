import { expect, test } from "vitest";

import { isTransferItemSelected, setTransferItemSelected } from "./selection";

test("excluding a repository excludes descendants and preserves nested choices", () => {
  const parents = new Map<string, string | null>([
    ["repository", null],
    ["settings", "repository"],
    ["name", "settings"],
    ["description", "settings"],
  ]);
  let excluded = setTransferItemSelected("description", false, []);
  excluded = setTransferItemSelected("repository", false, excluded);
  expect(isTransferItemSelected("name", excluded, parents)).toBe(false);
  excluded = setTransferItemSelected("repository", true, excluded);
  expect(isTransferItemSelected("name", excluded, parents)).toBe(true);
  expect(isTransferItemSelected("description", excluded, parents)).toBe(false);
});

test("malformed cyclic parent data cannot hang the selection view", () => {
  expect(
    isTransferItemSelected(
      "one",
      [],
      new Map([
        ["one", "two"],
        ["two", "one"],
      ]),
    ),
  ).toBe(false);
});
