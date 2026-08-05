import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  getAppSecrets,
  getPreviousCredentialKeys,
  parseAppSecretMaterial,
} from "./app-secret";

const ROOT = randomBytes(32).toString("base64");
const OTHER_ROOT = randomBytes(32).toString("base64");

describe("parseAppSecretMaterial", () => {
  test("accepts base64 and hex encodings of 32 bytes", () => {
    const raw = randomBytes(32);
    expect(
      parseAppSecretMaterial(raw.toString("base64"), "APP_SECRET"),
    ).toEqual(raw);
    expect(parseAppSecretMaterial(raw.toString("hex"), "APP_SECRET")).toEqual(
      raw,
    );
  });

  test.each([
    ["a passphrase padded well past thirty-two characters", "passphrase"],
    [randomBytes(16).toString("base64"), "too short"],
    [randomBytes(48).toString("base64"), "too long"],
    ["", "empty"],
    [`${randomBytes(32).toString("base64")}extra`, "trailing garbage"],
  ])("rejects %s (%s)", (value) => {
    expect(() => parseAppSecretMaterial(value, "APP_SECRET")).toThrow(
      /exactly 32 random bytes/,
    );
  });
});

describe("getAppSecrets", () => {
  test("derives three distinct secrets from one root", () => {
    const secrets = getAppSecrets({ APP_SECRET: ROOT });
    expect(secrets.credentialKey).toHaveLength(32);
    expect(secrets.ephemeral).toBe(false);
    // Domain separation: no derivation may collide with another.
    const values = [
      secrets.authSecret,
      secrets.credentialKey.toString("base64"),
      secrets.otaTokenSecret,
    ];
    expect(new Set(values).size).toBe(3);
  });

  test("is deterministic for a root and diverges across roots", () => {
    expect(getAppSecrets({ APP_SECRET: ROOT })).toEqual(
      getAppSecrets({ APP_SECRET: ROOT }),
    );
    expect(getAppSecrets({ APP_SECRET: OTHER_ROOT }).credentialKey).not.toEqual(
      getAppSecrets({ APP_SECRET: ROOT }).credentialKey,
    );
  });

  test("treats base64 and hex spellings of one root as the same secret", () => {
    const raw = randomBytes(32);
    expect(getAppSecrets({ APP_SECRET: raw.toString("hex") })).toEqual(
      getAppSecrets({ APP_SECRET: raw.toString("base64") }),
    );
  });

  test("throws when APP_SECRET is missing, in every environment", () => {
    for (const NODE_ENV of ["development", "test", "production"]) {
      expect(() => getAppSecrets({ NODE_ENV })).toThrow(
        /APP_SECRET is required/,
      );
    }
  });

  test("falls back to an ephemeral root only while building", () => {
    const secrets = getAppSecrets({ NEXT_PHASE: "phase-production-build" });
    expect(secrets.ephemeral).toBe(true);
  });

  test("a configured root is never ephemeral, even during a build", () => {
    const secrets = getAppSecrets({
      APP_SECRET: ROOT,
      NEXT_PHASE: "phase-production-build",
    });
    expect(secrets.ephemeral).toBe(false);
    expect(secrets.credentialKey).toEqual(
      getAppSecrets({ APP_SECRET: ROOT }).credentialKey,
    );
  });
});

describe("getPreviousCredentialKeys", () => {
  test("is empty when no rotation is in progress", () => {
    expect(getPreviousCredentialKeys({ APP_SECRET: ROOT })).toEqual([]);
  });

  test("derives one credential key per previous root, in order", () => {
    const keys = getPreviousCredentialKeys({
      APP_SECRET: ROOT,
      APP_SECRET_PREVIOUS: `${OTHER_ROOT}, ${ROOT}`,
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(
      getAppSecrets({ APP_SECRET: OTHER_ROOT }).credentialKey,
    );
    expect(keys[1]).toEqual(getAppSecrets({ APP_SECRET: ROOT }).credentialKey);
  });

  test("rejects a malformed previous root rather than skipping it", () => {
    expect(() =>
      getPreviousCredentialKeys({
        APP_SECRET: ROOT,
        APP_SECRET_PREVIOUS: "not-a-key",
      }),
    ).toThrow(/APP_SECRET_PREVIOUS\[0\]/);
  });
});
