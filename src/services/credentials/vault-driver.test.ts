// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { VaultCredentialStoreConfig } from "./config";
import { CREDENTIALS } from "./types";
import { VaultCredentialDriver } from "./vault-driver";

function config(
  overrides: Partial<VaultCredentialStoreConfig> = {},
): VaultCredentialStoreConfig {
  return {
    storageType: "vault",
    address: new URL("https://vault.test:8200/base"),
    token: "vault-token-secret",
    namespace: "team-a",
    mount: "secret",
    pathPrefix: "ai-development-environment/credentials",
    headers: { "X-Tenant": "blue" },
    caCertPath: null,
    tlsServerName: null,
    skipVerify: false,
    readOnly: false,
    ...overrides,
  };
}

function response(statusCode: number, body: unknown = {}) {
  return {
    statusCode,
    body: { text: async () => JSON.stringify(body) },
  };
}

describe("VaultCredentialDriver", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("uses KV v2 data paths and sends standard plus custom headers", async () => {
    const request = vi.fn().mockResolvedValue(
      response(200, {
        data: {
          data: {
            value: Buffer.from("jira-secret").toString("base64"),
            version: 1,
            kind: CREDENTIALS.jiraApiToken.kind,
          },
        },
      }),
    );
    const driver = new VaultCredentialDriver(
      config(),
      request as never,
      () => ({}) as never,
    );

    await expect(driver.get(CREDENTIALS.jiraApiToken)).resolves.toEqual(
      Buffer.from("jira-secret"),
    );
    const [url, options] = request.mock.calls[0];
    expect(url).toBe(
      "https://vault.test:8200/base/v1/secret/data/ai-development-environment/credentials/jira/default/api-token",
    );
    expect(options.headers).toMatchObject({
      "X-Tenant": "blue",
      accept: "application/json",
      "x-vault-request": "true",
      "x-vault-token": "vault-token-secret",
      "x-vault-namespace": "team-a",
    });
    expect(options.headersTimeout).toBe(10_000);
    expect(options.bodyTimeout).toBe(10_000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test("writes versioned payloads and permanently deletes KV metadata", async () => {
    const request = vi.fn().mockResolvedValue(response(204));
    const driver = new VaultCredentialDriver(
      config({ address: new URL("https://vault.test") }),
      request as never,
      () => ({}) as never,
    );
    await driver.set(CREDENTIALS.githubPersonalAccessToken, Buffer.from("pat"));
    await driver.delete(CREDENTIALS.githubPersonalAccessToken);

    const [writeUrl, writeOptions] = request.mock.calls[0];
    expect(writeUrl).toContain(
      "/v1/secret/data/ai-development-environment/credentials/github/default/personal-access-token",
    );
    expect(JSON.parse(writeOptions.body)).toEqual({
      data: {
        value: Buffer.from("pat").toString("base64"),
        version: 1,
        kind: CREDENTIALS.githubPersonalAccessToken.kind,
        ownerId: CREDENTIALS.githubPersonalAccessToken.ownerId,
      },
    });
    expect(request.mock.calls[1][0]).toContain(
      "/v1/secret/metadata/ai-development-environment/credentials/github/default/personal-access-token",
    );
    expect(request.mock.calls[1][1].method).toBe("DELETE");
  });

  test("returns null on 404 and does not expose Vault response bodies", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(404, { errors: ["secret-body"] }))
      .mockResolvedValueOnce(response(403, { errors: ["vault-token-secret"] }));
    const driver = new VaultCredentialDriver(
      config(),
      request as never,
      () => ({}) as never,
    );
    await expect(driver.get(CREDENTIALS.jiraApiToken)).resolves.toBeNull();
    const failure = driver.get(CREDENTIALS.jiraApiToken);
    await expect(failure).rejects.toThrow("HTTP 403");
    await expect(failure).rejects.not.toThrow("vault-token-secret");
  });

  test("describes stored credentials without returning the secret", async () => {
    const request = vi.fn().mockResolvedValue(
      response(200, {
        data: {
          data: {
            value: Buffer.from("jira-secret").toString("base64"),
            version: 1,
            kind: CREDENTIALS.jiraApiToken.kind,
            ownerId: "default",
          },
        },
      }),
    );
    const driver = new VaultCredentialDriver(
      config(),
      request as never,
      () => ({}) as never,
    );

    const described = await driver.describe(CREDENTIALS.jiraApiToken.id);
    expect(described).toEqual({
      id: CREDENTIALS.jiraApiToken.id,
      kind: CREDENTIALS.jiraApiToken.kind,
      ownerId: "default",
    });
    expect(JSON.stringify(described)).not.toContain("jira-secret");
  });

  test("recovers the owner from the path when the payload predates it", async () => {
    const request = vi.fn().mockResolvedValue(
      response(200, {
        data: {
          data: {
            value: Buffer.from("headers").toString("base64"),
            version: 1,
            kind: "external-mcp-server-headers",
          },
        },
      }),
    );
    const driver = new VaultCredentialDriver(
      config(),
      request as never,
      () => ({}) as never,
    );

    await expect(
      driver.describe("external-mcp-server/server-7/headers"),
    ).resolves.toEqual({
      id: "external-mcp-server/server-7/headers",
      kind: "external-mcp-server-headers",
      ownerId: "server-7",
    });
  });

  test("rejects payloads whose kind is not a known credential", async () => {
    const request = vi.fn().mockResolvedValue(
      response(200, {
        data: {
          data: {
            value: Buffer.from("someone-elses-secret").toString("base64"),
            version: 1,
            kind: "unrelated-application-secret",
          },
        },
      }),
    );
    const driver = new VaultCredentialDriver(
      config(),
      request as never,
      () => ({}) as never,
    );

    await expect(driver.describe("unrelated/default/secret")).rejects.toThrow(
      "invalid credential payload",
    );
  });

  test("walks nested KV metadata folders when listing", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(200, { data: { keys: ["jira/"] } }))
      .mockResolvedValueOnce(response(200, { data: { keys: ["default/"] } }))
      .mockResolvedValueOnce(response(200, { data: { keys: ["api-token"] } }))
      .mockResolvedValue(response(404));
    const driver = new VaultCredentialDriver(
      config(),
      request as never,
      () => ({}) as never,
    );

    await expect(driver.list()).resolves.toEqual(["jira/default/api-token"]);
    expect(request.mock.calls[0][0]).toBe(
      "https://vault.test:8200/base/v1/secret/metadata/ai-development-environment/credentials?list=true",
    );
    expect(request.mock.calls[2][0]).toContain(
      "/metadata/ai-development-environment/credentials/jira/default?list=true",
    );
  });

  test("refuses writes and deletes on a read-only install", async () => {
    const request = vi.fn();
    const driver = new VaultCredentialDriver(
      config({ readOnly: true }),
      request as never,
      () => ({}) as never,
    );

    await expect(
      driver.set(CREDENTIALS.jiraApiToken, Buffer.from("token")),
    ).rejects.toThrow("read-only Vault");
    await expect(driver.delete(CREDENTIALS.jiraApiToken)).rejects.toThrow(
      "read-only Vault",
    );
    expect(request).not.toHaveBeenCalled();
  });

  test("reports a denied write as read-only access rather than a bare 403", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(response(403, { errors: ["permission denied"] }));
    const driver = new VaultCredentialDriver(
      config(),
      request as never,
      () => ({}) as never,
    );

    const failure = driver.set(CREDENTIALS.jiraApiToken, Buffer.from("token"));
    await expect(failure).rejects.toThrow("read-only access");
    await expect(failure).rejects.toMatchObject({
      code: "CREDENTIAL_STORE_READ_ONLY",
    });
  });

  test("sanitizes transport errors and configures CA, SNI, and verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ade-vault-ca-"));
    directories.push(directory);
    const caPath = join(directory, "ca.pem");
    await writeFile(caPath, "test-ca");
    const dispatcherFactory = vi.fn(() => ({}) as never);
    const transportError = Object.assign(
      new Error("request with vault-token-secret and blue failed"),
      { code: "UND_ERR_CONNECT_TIMEOUT" },
    );
    const request = vi.fn().mockRejectedValue(transportError);
    const driver = new VaultCredentialDriver(
      config({
        caCertPath: caPath,
        tlsServerName: "vault.internal",
        skipVerify: true,
      }),
      request as never,
      dispatcherFactory,
    );
    await driver.initialize();
    expect(dispatcherFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        maxResponseSize: 64 * 1024 * 1024,
        connect: expect.objectContaining({
          ca: Buffer.from("test-ca"),
          servername: "vault.internal",
          rejectUnauthorized: false,
        }),
      }),
    );
    const failure = driver.get(CREDENTIALS.jiraApiToken);
    await expect(failure).rejects.toThrow("UND_ERR_CONNECT_TIMEOUT");
    await expect(failure).rejects.not.toThrow("vault-token-secret");
    await expect(failure).rejects.not.toThrow("blue");
  });
});
