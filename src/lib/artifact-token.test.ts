import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ARTIFACT_TOKEN_TTL_MS,
  signArtifactToken,
  verifyArtifactToken,
} from "./artifact-token";

beforeEach(() => {
  process.env.OTA_TOKEN_SECRET = "test-secret";
});

afterEach(() => {
  delete process.env.OTA_TOKEN_SECRET;
});

describe("artifact tokens", () => {
  test("verifies a token it just signed", () => {
    const { token, expires } = signArtifactToken("artifact-1");
    expect(verifyArtifactToken("artifact-1", token, String(expires))).toBe(
      true,
    );
  });

  test("defaults to the configured lifetime", () => {
    const now = Date.now();
    const { expires } = signArtifactToken("artifact-1");
    expect(expires).toBeGreaterThanOrEqual(now + ARTIFACT_TOKEN_TTL_MS - 1_000);
    expect(expires).toBeLessThanOrEqual(now + ARTIFACT_TOKEN_TTL_MS + 1_000);
  });

  test("rejects a token for a different artifact", () => {
    const { token, expires } = signArtifactToken("artifact-1");
    expect(verifyArtifactToken("artifact-2", token, String(expires))).toBe(
      false,
    );
  });

  test("rejects an expired token", () => {
    const expiresAt = Date.now() - 1_000;
    const { token } = signArtifactToken("artifact-1", expiresAt);
    expect(verifyArtifactToken("artifact-1", token, String(expiresAt))).toBe(
      false,
    );
  });

  test("rejects a tampered expiry", () => {
    const { token, expires } = signArtifactToken("artifact-1");
    expect(
      verifyArtifactToken("artifact-1", token, String(expires + 60_000)),
    ).toBe(false);
  });

  test("rejects a tampered token", () => {
    const { token, expires } = signArtifactToken("artifact-1");
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(verifyArtifactToken("artifact-1", tampered, String(expires))).toBe(
      false,
    );
  });

  test("rejects a token signed with a different secret", () => {
    const { token, expires } = signArtifactToken("artifact-1");
    process.env.OTA_TOKEN_SECRET = "another-secret";
    expect(verifyArtifactToken("artifact-1", token, String(expires))).toBe(
      false,
    );
  });

  test("rejects a missing token or expiry", () => {
    const { token, expires } = signArtifactToken("artifact-1");
    expect(verifyArtifactToken("artifact-1", null, String(expires))).toBe(
      false,
    );
    expect(verifyArtifactToken("artifact-1", token, null)).toBe(false);
  });

  test("rejects a non-numeric expiry", () => {
    const { token } = signArtifactToken("artifact-1");
    expect(verifyArtifactToken("artifact-1", token, "soon")).toBe(false);
  });

  test("rejects a token of a different length without throwing", () => {
    const { expires } = signArtifactToken("artifact-1");
    expect(verifyArtifactToken("artifact-1", "short", String(expires))).toBe(
      false,
    );
  });
});
