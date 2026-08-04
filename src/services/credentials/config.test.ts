// @vitest-environment node
import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { readCredentialStoreConfig } from "./config";

describe("credential store configuration", () => {
  test("derives the database encryption key from APP_SECRET", () => {
    const result = readCredentialStoreConfig(
      { APP_SECRET: randomBytes(32).toString("base64") },
      "linux",
    );
    expect(result.storageType).toBe("database");
    expect(result.errors).toEqual([]);
    expect(result.config).toMatchObject({ storageType: "database" });
    const config = result.config as { encryptionKey: Buffer };
    expect(config.encryptionKey).toHaveLength(32);
  });

  test("database storage has no plaintext mode", () => {
    const result = readCredentialStoreConfig({}, "linux");
    expect(result.config).toBeNull();
    expect(result.errors[0]?.code).toBe("APP_SECRET_INVALID");
  });

  test("rejects an APP_SECRET that is not exactly 32 bytes", () => {
    const result = readCredentialStoreConfig({ APP_SECRET: "not-base64" });
    expect(result.config).toBeNull();
    expect(result.errors[0]?.code).toBe("APP_SECRET_INVALID");
  });

  test("refuses to open the database store with the build-phase placeholder", () => {
    const result = readCredentialStoreConfig({
      NEXT_PHASE: "phase-production-build",
    });
    expect(result.config).toBeNull();
    expect(result.errors[0]?.code).toBe("APP_SECRET_INVALID");
  });

  test("derives previous keys from APP_SECRET_PREVIOUS for rotation", () => {
    const result = readCredentialStoreConfig({
      APP_SECRET: randomBytes(32).toString("base64"),
      APP_SECRET_PREVIOUS: `${randomBytes(32).toString("base64")},${randomBytes(32).toString("base64")}`,
    });
    expect(result.config).toMatchObject({ storageType: "database" });
    expect(
      (result.config as { previousKeys: Buffer[] }).previousKeys,
    ).toHaveLength(2);
  });

  test("Vault storage needs no APP_SECRET", () => {
    const result = readCredentialStoreConfig({
      CREDENTIAL_STORAGE_TYPE: "vault",
      VAULT_ADDR: "https://vault.test",
      VAULT_TOKEN: "token",
    });
    expect(result.errors).toEqual([]);
    expect(result.config).toMatchObject({ storageType: "vault" });
    expect(result.config).not.toHaveProperty("encryptionKey");
  });

  test("Keychain storage needs no APP_SECRET", () => {
    const result = readCredentialStoreConfig(
      { CREDENTIAL_STORAGE_TYPE: "keychain" },
      "darwin",
    );
    expect(result.errors).toEqual([]);
    expect(result.config).toMatchObject({ storageType: "keychain" });
    expect(result.config).not.toHaveProperty("encryptionKey");
  });

  test("parses Vault headers and reports insecure transport settings", () => {
    const result = readCredentialStoreConfig({
      CREDENTIAL_STORAGE_TYPE: "vault",
      VAULT_ADDR: "http://vault.test:8200",
      VAULT_TOKEN: "standard-token-secret",
      VAULT_NAMESPACE: "team",
      CREDENTIAL_VAULT_HEADERS: JSON.stringify({ "X-Tenant": "blue" }),
      VAULT_SKIP_VERIFY: "true",
    });
    expect(result.errors).toEqual([]);
    expect(result.config).toMatchObject({
      storageType: "vault",
      headers: { "X-Tenant": "blue" },
      mount: "secret",
      pathPrefix: "ai-development-environment/credentials",
    });
    expect(result.warnings.map(({ code }) => code)).toEqual([
      "VAULT_INSECURE_HTTP",
      "VAULT_TLS_VERIFICATION_DISABLED",
    ]);
    expect(JSON.stringify(result.details)).not.toContain(
      "standard-token-secret",
    );
    expect(JSON.stringify(result.details)).not.toContain("blue");
  });

  test.each([
    {
      VAULT_TOKEN: "standard",
      CREDENTIAL_VAULT_HEADERS: '{"X-Vault-Token":"custom"}',
    },
    {
      VAULT_NAMESPACE: "standard",
      CREDENTIAL_VAULT_HEADERS: '{"x-vault-namespace":"custom"}',
    },
    { CREDENTIAL_VAULT_HEADERS: '{"Content-Length":"12"}' },
    { CREDENTIAL_VAULT_HEADERS: '{"X-Vault-Request":"false"}' },
  ])("rejects conflicting or managed Vault headers: %j", (values) => {
    const result = readCredentialStoreConfig({
      CREDENTIAL_STORAGE_TYPE: "vault",
      VAULT_ADDR: "https://vault.test",
      ...values,
    });
    expect(result.config).toBeNull();
    expect(result.errors[0]?.code).toBe("VAULT_CONFIGURATION_INVALID");
  });

  test("treats read-only access as a Vault-only setting", () => {
    const vault = readCredentialStoreConfig({
      CREDENTIAL_STORAGE_TYPE: "vault",
      VAULT_ADDR: "https://vault.test",
      CREDENTIAL_VAULT_READ_ONLY: "true",
    });
    expect(vault.config).toMatchObject({
      storageType: "vault",
      readOnly: true,
    });
    expect(vault.warnings).toEqual([]);
    expect(vault.details).toContainEqual({
      label: "Vault access",
      value: "Read-only",
    });

    const writable = readCredentialStoreConfig({
      CREDENTIAL_STORAGE_TYPE: "vault",
      VAULT_ADDR: "https://vault.test",
    });
    expect(writable.config).toMatchObject({ readOnly: false });
    expect(writable.details).toContainEqual({
      label: "Vault access",
      value: "Read-write",
    });
  });

  test.each(["database", "keychain"] as const)(
    "warns that read-only access is ignored by %s storage",
    (storageType) => {
      const result = readCredentialStoreConfig(
        {
          CREDENTIAL_STORAGE_TYPE: storageType,
          CREDENTIAL_VAULT_READ_ONLY: "true",
          APP_SECRET: randomBytes(32).toString("base64"),
        },
        "darwin",
      );
      expect(result.warnings.map(({ code }) => code)).toContain(
        "VAULT_READ_ONLY_IGNORED",
      );
      expect(result.config).not.toHaveProperty("readOnly");
    },
  );

  test("rejects an unparseable read-only flag", () => {
    const result = readCredentialStoreConfig({
      CREDENTIAL_STORAGE_TYPE: "vault",
      VAULT_ADDR: "https://vault.test",
      CREDENTIAL_VAULT_READ_ONLY: "yes",
    });
    expect(result.config).toBeNull();
    expect(result.errors[0]?.code).toBe("VAULT_CONFIGURATION_INVALID");
  });

  test("reports Keychain as unsupported on Linux without loading it", () => {
    const result = readCredentialStoreConfig(
      { CREDENTIAL_STORAGE_TYPE: "keychain" },
      "linux",
    );
    expect(result.storageType).toBe("keychain");
    expect(result.errors[0]?.code).toBe("KEYCHAIN_UNSUPPORTED_PLATFORM");
  });
});
