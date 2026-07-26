import { describe, expect, test } from "vitest";

import { redactSensitiveToolOutput } from "./service-tool";

describe("service-tool output redaction", () => {
  test("removes sensitive values recursively while preserving safe metadata", () => {
    const output = redactSensitiveToolOutput({
      id: "resource-1",
      token: "plain-token",
      enrollmentToken: "enrollment-secret",
      nativeSession: { transcript: "hidden" },
      nested: {
        privateKeyPem: "private-key",
        p12Base64: "certificate-secret",
        tokenMasked: "abcd…wxyz",
      },
    });

    expect(output).toEqual({
      id: "resource-1",
      nested: { tokenMasked: "abcd…wxyz" },
    });
    expect(JSON.stringify(output)).not.toContain("secret");
  });
});
