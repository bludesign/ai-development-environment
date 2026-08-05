// @vitest-environment node
import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { decryptCredential, encryptCredential } from "./crypto";
import { CREDENTIALS } from "./types";

describe("credential encryption", () => {
  test("round trips with AES-256-GCM and rejects tampering", () => {
    const key = randomBytes(32);
    const encrypted = encryptCredential(
      CREDENTIALS.githubPersonalAccessToken,
      Buffer.from("github-secret"),
      key,
    );
    expect(
      decryptCredential(
        CREDENTIALS.githubPersonalAccessToken,
        encrypted,
        key,
      ).toString("utf8"),
    ).toBe("github-secret");

    const tampered = Buffer.from(encrypted.payload);
    tampered[0] ^= 1;
    expect(() =>
      decryptCredential(
        CREDENTIALS.githubPersonalAccessToken,
        { ...encrypted, payload: tampered },
        key,
      ),
    ).toThrow("could not be decrypted");
  });

  test("authenticates the credential ID and kind as AAD", () => {
    const key = randomBytes(32);
    const encrypted = encryptCredential(
      CREDENTIALS.jiraApiToken,
      Buffer.from("jira-secret"),
      key,
    );
    expect(() =>
      decryptCredential(CREDENTIALS.githubPersonalAccessToken, encrypted, key),
    ).toThrow("could not be decrypted");
  });
});
