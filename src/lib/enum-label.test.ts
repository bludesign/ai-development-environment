import { describe, expect, test } from "vitest";

import {
  formatEnumLabel,
  formatModelLabel,
  formatProviderLabel,
  splitModelLabel,
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

describe("splitModelLabel", () => {
  test("peels a trailing tier off the model name", () => {
    expect(splitModelLabel("MiniMax-M3 Free")).toEqual({
      name: "MiniMax-M3",
      qualifier: "Free",
    });
    expect(splitModelLabel("Laguna S 2.1 Free")).toEqual({
      name: "Laguna S 2.1",
      qualifier: "Free",
    });
  });

  test("returns the name alone where there is no tier", () => {
    expect(splitModelLabel("GLM-5.2")).toEqual({ name: "GLM-5.2" });
    expect(splitModelLabel("Kimi K3 (2x usage)")).toEqual({
      name: "Kimi K3 (2x usage)",
    });
  });

  test("still drops the opencode-go namespace", () => {
    expect(splitModelLabel("opencode-go/grok-code")).toEqual({
      name: "grok-code",
    });
  });
});
