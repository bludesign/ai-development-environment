import { describe, expect, test } from "vitest";

import {
  formatBetterAuthLogArguments,
  redactSensitiveAuthLogOutput,
} from "./auth-logger";

describe("Better Auth log redaction", () => {
  test("redacts OAuth response fields, proof credentials, and callback queries", () => {
    const output = redactSensitiveAuthLogOutput(
      'access_token: "access-value", refresh_token: "refresh-value", client_secret: "client-value", code_verifier: "verifier-value", token: "token-value"\nBearer header.payload.signature\nDPoP proof-value\nhttps://example.com/callback?code=code-value&state=public-state',
    );
    for (const secret of [
      "access-value",
      "refresh-value",
      "client-value",
      "verifier-value",
      "token-value",
      "header.payload.signature",
      "proof-value",
      "code-value",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("state=public-state");
  });
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
