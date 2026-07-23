import { describe, expect, test } from "vitest";

import { firstString } from "./provider.js";

describe("firstString", () => {
  test("retains depth-first key priority", () => {
    expect(
      firstString({
        text: { content: "preferred" },
        message: "fallback",
      }),
    ).toBe("preferred");
  });

  test("handles cyclic provider payloads", () => {
    const payload: Record<string, unknown> = {};
    payload.content = payload;
    payload.output = "complete";

    expect(firstString(payload)).toBe("complete");
  });

  test("handles deeply nested provider payloads without recursion", () => {
    let payload: unknown = "complete";
    for (let index = 0; index < 25_000; index += 1) {
      payload = { content: payload };
    }

    expect(firstString(payload)).toBe("complete");
  });
});
