import { describe, expect, test } from "vitest";

import { pullRequestResourceId } from "./resources";

describe("workflow resource identities", () => {
  test("scopes pull request numbers to a normalized repository", () => {
    expect(pullRequestResourceId("Acme", "Widgets", 42)).toBe(
      "acme/widgets#42",
    );
    expect(pullRequestResourceId("Elsewhere", "Widgets", 42)).not.toBe(
      pullRequestResourceId("Acme", "Widgets", 42),
    );
  });
});
