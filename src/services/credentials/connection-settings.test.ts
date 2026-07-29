// @vitest-environment node
import { describe, expect, test } from "vitest";

import { CredentialStoreOperationError } from "./driver";
import {
  apnsCertificateCatalog,
  cacheServerConnectionSettings,
  githubAppConnectionSettings,
  jiraConnectionSettings,
} from "./connection-settings";
import { decodeJsonCredential, encodeJsonCredential } from "./types";

describe("connection credential payload validation", () => {
  test("round trips a versioned connection payload", () => {
    const value = {
      baseUrl: "https://cache.example.test",
      headers: [{ name: "x-tenant", value: "tenant-secret" }],
    };
    expect(
      cacheServerConnectionSettings(
        decodeJsonCredential(encodeJsonCredential(value)),
      ),
    ).toEqual(value);
  });

  test.each([
    () => jiraConnectionSettings({ siteUrl: "", email: "dev@example.test" }),
    () => githubAppConnectionSettings({ appId: 42, installationId: "7" }),
    () => cacheServerConnectionSettings({ baseUrl: "https://cache.test" }),
    () =>
      apnsCertificateCatalog([
        {
          id: "duplicate",
          name: "First",
          topic: "com.example.app",
          environment: "SANDBOX",
        },
        {
          id: "duplicate",
          name: "Second",
          topic: "com.example.app",
          environment: "PRODUCTION",
        },
      ]),
  ])("rejects an invalid typed payload", (read) => {
    expect(read).toThrowError(CredentialStoreOperationError);
    try {
      read();
    } catch (error) {
      expect(error).toMatchObject({ code: "CREDENTIAL_DATA_INVALID" });
    }
  });
});
