import { afterEach, describe, expect, test, vi } from "vitest";

import { createClientId, exportFileStem } from "./browser-utils";

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

describe("exportFileStem", () => {
  test("collapses unsafe runs into single dashes", () => {
    expect(exportFileStem("Nightly Build — v2")).toBe("nightly-build-v2");
  });

  test("trims the dashes an unsafe edge would otherwise leave behind", () => {
    expect(exportFileStem("[Release]")).toBe("release");
  });

  test("falls back when a name has nothing safe left in it", () => {
    expect(exportFileStem("!!!")).toBe("export");
    expect(exportFileStem("")).toBe("export");
  });
});
