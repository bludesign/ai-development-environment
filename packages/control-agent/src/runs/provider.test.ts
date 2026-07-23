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

  test("traverses Codex turn items", () => {
    expect(
      firstString({
        id: "turn-1",
        items: [{ type: "agent_message", text: "Imported Codex output" }],
      }),
    ).toBe("Imported Codex output");
  });

  test("traverses OpenCode message parts", () => {
    expect(
      firstString({
        info: { role: "assistant" },
        parts: [{ type: "text", text: "Imported OpenCode output" }],
      }),
    ).toBe("Imported OpenCode output");
  });
});
