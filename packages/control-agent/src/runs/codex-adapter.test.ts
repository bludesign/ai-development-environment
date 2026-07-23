import { describe, expect, test } from "vitest";

import {
  codexVersionFromUserAgent,
  supportedCodexVersion,
} from "./codex-adapter.js";

describe("Codex app-server protocol guard", () => {
  test("accepts the generated protocol fixture version", () => {
    const version = codexVersionFromUserAgent(
      "Codex Desktop/0.145.0 (Mac OS 26.5; arm64) dumb (control-agent; 0.1.0)",
    );
    expect(version).toBe("0.145.0");
    expect(supportedCodexVersion(version)).toBe(true);
    expect(supportedCodexVersion("0.144.6")).toBe(true);
    expect(supportedCodexVersion("0.143.9")).toBe(false);
  });

  test.each(["", "Codex Desktop/dev", "Codex Desktop 0.145.0"])(
    "rejects an unparseable user agent: %s",
    (value) => expect(codexVersionFromUserAgent(value)).toBeNull(),
  );
});
