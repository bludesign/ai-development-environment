// @vitest-environment node
import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { readCredentialStoreConfig } from "./config";

describe("credential store configuration", () => {
  test("defaults to plaintext database storage with a warning", () => {
    const result = readCredentialStoreConfig({}, "linux");
    expect(result.storageType).toBe("database");
    expect(result.config).toMatchObject({
      storageType: "database",
      encryptionKey: null,
    });
    expect(result.warnings.map(({ code }) => code)).toContain(
      "DATABASE_UNENCRYPTED",
    );
  });

  test("accepts a valid encryption key and rejects an invalid one", () => {
    const valid = readCredentialStoreConfig({
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    });
    expect(valid.errors).toEqual([]);
    expect(valid.config).toMatchObject({ storageType: "database" });

    const invalid = readCredentialStoreConfig({
      CREDENTIAL_ENCRYPTION_KEY: "not-base64",
    });
    expect(invalid.config).toBeNull();
    expect(invalid.errors[0]?.code).toBe("CREDENTIAL_ENCRYPTION_KEY_INVALID");
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

  test("reports Keychain as unsupported on Linux without loading it", () => {
    const result = readCredentialStoreConfig(
      { CREDENTIAL_STORAGE_TYPE: "keychain" },
      "linux",
    );
    expect(result.storageType).toBe("keychain");
    expect(result.errors[0]?.code).toBe("KEYCHAIN_UNSUPPORTED_PLATFORM");
  });
});
