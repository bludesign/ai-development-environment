import { describe, expect, test } from "vitest";

import {
  formatBetterAuthLogArguments,
  redactSensitiveAuthLogOutput,
} from "./auth-logger";

describe("Better Auth log redaction", () => {
  test("redacts sensitive fields in Prisma-style validation output", () => {
    const output = redactSensitiveAuthLogOutput(`data: {
      password: "salt:password-hash",
      accessToken: "provider-token",
      providerId: "credential"
    }`);

    expect(output).not.toContain("salt:password-hash");
    expect(output).not.toContain("provider-token");
    expect(output).toContain('password: "[REDACTED]"');
    expect(output).toContain('accessToken: "[REDACTED]"');
    expect(output).toContain('providerId: "credential"');
  });

  test("redacts sensitive fields carried by Error arguments", () => {
    const [message, error] = formatBetterAuthLogArguments(
      "error",
      "Account creation failed",
      [new Error('Invalid create: { password: "salt:password-hash" }')],
    );

    expect(message).toContain("ERROR [Better Auth]: Account creation failed");
    expect(error).toContain('password: "[REDACTED]"');
    expect(error).not.toContain("salt:password-hash");
  });
});
