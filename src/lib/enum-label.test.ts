import { describe, expect, test } from "vitest";

import {
  formatEnumLabel,
  formatModelLabel,
  formatProviderLabel,
} from "./enum-label";

describe("formatEnumLabel", () => {
  test("title cases screaming snake case values", () => {
    expect(formatEnumLabel("IMPORTED_SYNCED")).toBe("Imported Synced");
    expect(formatEnumLabel("COMPLETED")).toBe("Completed");
    expect(formatEnumLabel("SUPERSEDED_BY_ANSWER_REVISION")).toBe(
      "Superseded By Answer Revision",
    );
  });

  test("leaves values that already carry their own casing alone", () => {
    expect(formatEnumLabel("feature/AIDE-66")).toBe("feature/AIDE-66");
    expect(formatEnumLabel("ReadFile")).toBe("ReadFile");
  });
});

describe("formatProviderLabel", () => {
  test("uses brand casing for known providers", () => {
    expect(formatProviderLabel("OPENCODE")).toBe("OpenCode");
    expect(formatProviderLabel("CLAUDE")).toBe("Claude");
  });

  test("falls back to title casing for unknown providers", () => {
    expect(formatProviderLabel("SOME_PROVIDER")).toBe("Some Provider");
  });
});

describe("formatModelLabel", () => {
  test("drops the opencode-go catalog namespace", () => {
    expect(formatModelLabel("opencode-go/grok-code")).toBe("grok-code");
    expect(formatModelLabel("OpenCode-Go/grok-code")).toBe("grok-code");
  });

  test("leaves other model identifiers untouched", () => {
    expect(formatModelLabel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(formatModelLabel("opencode/deepseek-v4-flash-free")).toBe(
      "opencode/deepseek-v4-flash-free",
    );
  });
});
