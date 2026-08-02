import { describe, expect, test } from "vitest";

import { isActiveCodebaseJobConflict } from "./codebase-busy";

describe("isActiveCodebaseJobConflict", () => {
  test("recognizes the database trigger used for command cross-kind conflicts", () => {
    expect(
      isActiveCodebaseJobConflict(
        new Error(
          "Error in connector: AgentJob_codebaseId_active_key (SQLITE_CONSTRAINT_TRIGGER)",
        ),
      ),
    ).toBe(true);
  });
});
