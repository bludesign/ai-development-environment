// @vitest-environment node
import { randomUUID } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import type { KeychainCredentialStoreConfig } from "./config";
import { KeychainCredentialDriver } from "./keychain-driver";
import { CREDENTIALS, type CredentialDescriptor } from "./types";

function config(platform: NodeJS.Platform): KeychainCredentialStoreConfig {
  return {
    storageType: "keychain",
    platform,
    service: "com.bludesign.ai-development-environment.credentials",
  };
}

describe("KeychainCredentialDriver", () => {
  test("does not load Darwin native code when selected on Linux", async () => {
    const loader = vi.fn();
    const driver = new KeychainCredentialDriver(config("linux"), loader);
    await expect(driver.initialize()).rejects.toMatchObject({
      code: "KEYCHAIN_UNSUPPORTED_PLATFORM",
    });
    await expect(driver.get(CREDENTIALS.jiraApiToken)).rejects.toThrow(
      "unavailable on this host",
    );
    expect(loader).not.toHaveBeenCalled();
  });

  test("performs CRUD through an injected native adapter on Darwin", async () => {
    const values = new Map<string, Uint8Array>();
    const loader = vi.fn(async () => ({
      AsyncEntry: class {
        constructor(
          readonly service: string,
          readonly username: string,
        ) {}
        async getSecret() {
          return values.get(this.username);
        }
        async setSecret(value: Uint8Array) {
          values.set(this.username, Uint8Array.from(value));
        }
        async deleteCredential() {
          return values.delete(this.username);
        }
      },
    }));
    const driver = new KeychainCredentialDriver(config("darwin"), loader);
    await driver.initialize();
    expect(loader).not.toHaveBeenCalled();
    await driver.set(CREDENTIALS.jiraApiToken, Buffer.from("jira-secret"));
    await expect(driver.get(CREDENTIALS.jiraApiToken)).resolves.toEqual(
      Buffer.from("jira-secret"),
    );
    await driver.delete(CREDENTIALS.jiraApiToken);
    await expect(driver.get(CREDENTIALS.jiraApiToken)).resolves.toBeNull();
    expect(loader).toHaveBeenCalled();
  });

  test.skipIf(
    process.platform !== "darwin" ||
      process.env.RUN_KEYCHAIN_INTEGRATION_TEST !== "true",
  )("runs an opt-in macOS Keychain smoke test and cleans up", async () => {
    const id = `integration-test/${randomUUID()}`;
    const descriptor: CredentialDescriptor = {
      id,
      kind: CREDENTIALS.jiraApiToken.kind,
      ownerId: id,
    };
    const driver = new KeychainCredentialDriver(config("darwin"));
    try {
      await driver.set(descriptor, Buffer.from("smoke-test"));
      await expect(driver.get(descriptor)).resolves.toEqual(
        Buffer.from("smoke-test"),
      );
    } finally {
      await driver.delete(descriptor).catch(() => undefined);
    }
  });
});
