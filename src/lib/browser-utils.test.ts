import { afterEach, describe, expect, test, vi } from "vitest";

import { createClientId } from "./browser-utils";

afterEach(() => vi.unstubAllGlobals());

describe("createClientId", () => {
  test("falls back when randomUUID rejects in a non-secure context", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new DOMException("A secure context is required");
      },
      getRandomValues: (bytes: Uint8Array) => bytes.fill(10),
    });

    expect(createClientId()).toBe("0a".repeat(16));
  });
});
