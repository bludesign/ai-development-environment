import { describe, expect, test } from "vitest";

import { isAnonymousAgentEnrollment } from "./graphql-auth";

describe("anonymous GraphQL enrollment guard", () => {
  test("allows one direct enrollAgent mutation", () => {
    expect(
      isAnonymousAgentEnrollment(`
        mutation Enroll($input: EnrollAgentInput!) {
          enrollAgent(input: $input) { agent { id } }
        }
      `),
    ).toBe(true);
  });

  test.each([
    "query { __schema { queryType { name } } }",
    "mutation { renamed: enrollAgent(input: {}) { agent { id } } }",
    "mutation { enrollAgent(input: {}) { agent { id } } health }",
    "mutation { enrollAgent(input: {}) @skip(if: false) { agent { id } } }",
    "mutation { otherMutation }",
    "not GraphQL",
  ])("rejects anonymous operation %s", (query) => {
    expect(isAnonymousAgentEnrollment(query)).toBe(false);
  });
});
