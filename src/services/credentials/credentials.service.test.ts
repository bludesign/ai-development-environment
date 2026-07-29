// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

import {
  CredentialService,
  resetCredentialAdoptionForTests,
} from "./credentials.service";
import { jiraConnectionSettings } from "./connection-settings";
import {
  apnsCertificateCredential,
  CREDENTIALS,
  encodeJsonCredential,
} from "./types";

const CREATE_CREDENTIAL_TABLE = `
  CREATE TABLE "Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "ownerId" TEXT,
    "storageType" TEXT NOT NULL,
    "payload" BLOB,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "encryptionVersion" INTEGER,
    "nonce" BLOB,
    "authTag" BLOB,
    "keyFingerprint" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`;

describe("CredentialService database backend", () => {
  let directory: string;
  let databasePath: string;
  let prisma: InstanceType<typeof PrismaClient>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ade-credentials-"));
    databasePath = join(directory, "test.db");
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: databasePath }),
    });
    await prisma.$executeRawUnsafe(CREATE_CREDENTIAL_TABLE);
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });

  test("stores plaintext by default and reports the warning", async () => {
    const service = new CredentialService({ env: {}, prisma });
    await service.setText(CREDENTIALS.jiraApiToken, "jira-secret");

    const row = await prisma.credential.findUniqueOrThrow({
      where: { id: CREDENTIALS.jiraApiToken.id },
    });
    expect(row.encrypted).toBe(false);
    expect(Buffer.from(row.payload!).toString("utf8")).toBe("jira-secret");
    await expect(service.getText(CREDENTIALS.jiraApiToken)).resolves.toBe(
      "jira-secret",
    );
    await expect(service.status()).resolves.toMatchObject({
      state: "WARNING",
      encryptionState: "PLAINTEXT",
      warnings: [{ code: "DATABASE_UNENCRYPTED" }],
    });
  });

  test("returns decoded JSON with credential metadata timestamps", async () => {
    const service = new CredentialService({ env: {}, prisma });
    const value = { siteUrl: "https://jira.example.test", email: "dev@test" };
    await service.setJson(CREDENTIALS.jiraConnectionSettings, value);

    const stored = await service.getJsonWithMetadata(
      CREDENTIALS.jiraConnectionSettings,
    );
    const row = await prisma.credential.findUniqueOrThrow({
      where: { id: CREDENTIALS.jiraConnectionSettings.id },
    });
    expect(stored).toEqual({
      value,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  test("validates typed JSON credentials when reading them", async () => {
    const service = new CredentialService({ env: {}, prisma });
    await service.setJson(CREDENTIALS.jiraConnectionSettings, {
      siteUrl: 42,
      email: "dev@example.test",
    });

    await expect(
      service.getValidatedJson(
        CREDENTIALS.jiraConnectionSettings,
        jiraConnectionSettings,
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_DATA_INVALID" });
  });

  test("encrypts new payloads and round trips without exposing payloads in inventory", async () => {
    const key = randomBytes(32).toString("base64");
    const service = new CredentialService({
      env: { CREDENTIAL_ENCRYPTION_KEY: key },
      prisma,
    });
    await service.setText(
      CREDENTIALS.githubPersonalAccessToken,
      "github-secret",
    );

    const row = await prisma.credential.findUniqueOrThrow({
      where: { id: CREDENTIALS.githubPersonalAccessToken.id },
    });
    expect(row.encrypted).toBe(true);
    expect(Buffer.from(row.payload!).toString("utf8")).not.toBe(
      "github-secret",
    );
    expect(row.nonce).toHaveLength(12);
    expect(row.authTag).toHaveLength(16);
    await expect(
      service.getText(CREDENTIALS.githubPersonalAccessToken),
    ).resolves.toBe("github-secret");
    expect(JSON.stringify(await service.list())).not.toContain("github-secret");
  });

  test("rejects tampered ciphertext", async () => {
    const service = new CredentialService({
      env: { CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
      prisma,
    });
    await service.setText(CREDENTIALS.jiraApiToken, "jira-secret");
    const row = await prisma.credential.findUniqueOrThrow({
      where: { id: CREDENTIALS.jiraApiToken.id },
    });
    const payload = Uint8Array.from(row.payload!);
    payload[0] ^= 1;
    await prisma.credential.update({
      where: { id: row.id },
      data: { payload },
    });
    await expect(service.getText(CREDENTIALS.jiraApiToken)).rejects.toThrow(
      "could not be decrypted",
    );
  });

  test("blocks a missing or changed key when encrypted rows exist", async () => {
    const originalKey = randomBytes(32).toString("base64");
    await new CredentialService({
      env: { CREDENTIAL_ENCRYPTION_KEY: originalKey },
      prisma,
    }).setText(CREDENTIALS.jiraApiToken, "jira-secret");

    const missing = new CredentialService({ env: {}, prisma });
    await expect(missing.ensureInitialized()).rejects.toMatchObject({
      code: "CREDENTIAL_ENCRYPTION_KEY_MISSING",
    });
    const missingStatus = await missing.status();
    expect(missingStatus).toMatchObject({
      state: "ERROR",
      encryptionState: "ERROR",
    });
    expect(missingStatus.warnings.map(({ code }) => code)).toEqual([
      "CREDENTIAL_ENCRYPTION_KEY_MISSING",
    ]);

    const changed = new CredentialService({
      env: { CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
      prisma,
    });
    await expect(changed.ensureInitialized()).rejects.toMatchObject({
      code: "CREDENTIAL_ENCRYPTION_KEY_MISMATCH",
    });
  });

  test("atomically encrypts every plaintext row when a key is added", async () => {
    const plaintext = new CredentialService({ env: {}, prisma });
    await plaintext.setText(CREDENTIALS.jiraApiToken, "jira-secret");
    await plaintext.setText(
      CREDENTIALS.githubPersonalAccessToken,
      "github-secret",
    );

    const encrypted = new CredentialService({
      env: { CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
      prisma,
    });
    await Promise.all([
      encrypted.ensureInitialized(),
      encrypted.ensureInitialized(),
      encrypted.ensureInitialized(),
    ]);
    expect(await prisma.credential.count({ where: { encrypted: true } })).toBe(
      2,
    );
    await expect(encrypted.getText(CREDENTIALS.jiraApiToken)).resolves.toBe(
      "jira-secret",
    );
  });

  test("removes swept plaintext from the SQLite database and WAL", async () => {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
    const secret = `plaintext-that-must-be-erased-${randomBytes(24).toString("hex")}`;
    const plaintext = new CredentialService({ env: {}, prisma });
    await plaintext.setText(CREDENTIALS.jiraApiToken, secret);
    await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE);");

    expect((await readFile(databasePath)).includes(Buffer.from(secret))).toBe(
      true,
    );

    const encrypted = new CredentialService({
      env: { CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
      prisma,
    });
    await encrypted.ensureInitialized();

    expect((await readFile(databasePath)).includes(Buffer.from(secret))).toBe(
      false,
    );
    const wal = await readFile(`${databasePath}-wal`).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return Buffer.alloc(0);
        }
        throw error;
      },
    );
    expect(wal).toHaveLength(0);
  });

  test("rolls back the entire startup sweep if one plaintext row is invalid", async () => {
    await prisma.credential.createMany({
      data: [
        {
          id: CREDENTIALS.jiraApiToken.id,
          kind: CREDENTIALS.jiraApiToken.kind,
          ownerId: "default",
          storageType: "database",
          payload: Uint8Array.from(Buffer.from("jira-secret")),
        },
        {
          id: CREDENTIALS.githubPersonalAccessToken.id,
          kind: CREDENTIALS.githubPersonalAccessToken.kind,
          ownerId: "default",
          storageType: "database",
          payload: null,
        },
      ],
    });
    const service = new CredentialService({
      env: { CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
      prisma,
    });
    await expect(service.ensureInitialized()).rejects.toMatchObject({
      code: "CREDENTIAL_DATA_INVALID",
    });
    expect(await prisma.credential.count({ where: { encrypted: true } })).toBe(
      0,
    );
  });

  test("deletes unreadable database rows and permits replacement credentials", async () => {
    const originalKey = randomBytes(32).toString("base64");
    await new CredentialService({
      env: { CREDENTIAL_ENCRYPTION_KEY: originalKey },
      prisma,
    }).setText(CREDENTIALS.jiraApiToken, "old-secret");

    const replacementKey = randomBytes(32).toString("base64");
    const service = new CredentialService({
      env: { CREDENTIAL_ENCRYPTION_KEY: replacementKey },
      prisma,
    });
    await expect(service.status()).resolves.toMatchObject({
      state: "ERROR",
      warnings: [
        expect.objectContaining({
          code: "CREDENTIAL_ENCRYPTION_KEY_MISMATCH",
        }),
      ],
    });

    const metadataOnlyMutation = vi.fn(async () => undefined);
    await service.delete(
      CREDENTIALS.githubPersonalAccessToken,
      metadataOnlyMutation,
    );
    expect(metadataOnlyMutation).toHaveBeenCalledOnce();

    await service.delete(CREDENTIALS.jiraApiToken);
    await service.setText(CREDENTIALS.jiraApiToken, "replacement-secret");
    await expect(service.getText(CREDENTIALS.jiraApiToken)).resolves.toBe(
      "replacement-secret",
    );
  });

  test("keeps inventory available when Keychain is selected on Linux", async () => {
    const loader = vi.fn();
    const service = new CredentialService({
      env: { CREDENTIAL_STORAGE_TYPE: "keychain" },
      platform: "linux",
      prisma,
      keychainModuleLoader: loader,
    });
    await expect(service.status()).resolves.toMatchObject({
      storageType: "keychain",
      state: "ERROR",
      warnings: [{ code: "KEYCHAIN_UNSUPPORTED_PLATFORM" }],
    });
    await expect(service.list()).resolves.toEqual([]);
    await expect(service.getText(CREDENTIALS.jiraApiToken)).rejects.toThrow(
      "only available",
    );
    expect(loader).not.toHaveBeenCalled();
  });

  test("reports backend mismatches and requires re-entry", async () => {
    await prisma.credential.create({
      data: {
        id: CREDENTIALS.jiraApiToken.id,
        kind: CREDENTIALS.jiraApiToken.kind,
        ownerId: "default",
        storageType: "vault",
      },
    });
    const service = new CredentialService({ env: {}, prisma });
    await expect(service.status()).resolves.toMatchObject({
      state: "WARNING",
      mismatchCount: 1,
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "BACKEND_MISMATCH" }),
      ]),
    });
    await expect(
      service.getText(CREDENTIALS.jiraApiToken),
    ).rejects.toMatchObject({ code: "BACKEND_MISMATCH" });

    await service.setText(CREDENTIALS.jiraApiToken, "re-entered");
    await expect(service.getText(CREDENTIALS.jiraApiToken)).resolves.toBe(
      "re-entered",
    );
    expect(
      await prisma.credential.findUniqueOrThrow({
        where: { id: CREDENTIALS.jiraApiToken.id },
      }),
    ).toMatchObject({ storageType: "database" });
  });

  test("serializes overlapping external writes through rollback and metadata commit", async () => {
    const values = new Map<string, Uint8Array>();
    const operations: string[] = [];
    const keychainModuleLoader = vi.fn(async () => ({
      AsyncEntry: class {
        constructor(
          readonly _service: string,
          readonly username: string,
        ) {}

        async getSecret() {
          return values.get(this.username);
        }

        async setSecret(value: Uint8Array) {
          const copy = Uint8Array.from(value);
          operations.push(
            `set:${this.username}:${Buffer.from(copy).toString("utf8")}`,
          );
          values.set(this.username, copy);
        }

        async deleteCredential() {
          operations.push(`delete:${this.username}`);
          return values.delete(this.username);
        }
      },
    }));
    const service = new CredentialService({
      env: { CREDENTIAL_STORAGE_TYPE: "keychain" },
      platform: "darwin",
      prisma,
      keychainModuleLoader,
    });
    const entries = (ownerId: string) => [
      {
        descriptor: { ...CREDENTIALS.cacheServerApiKey, ownerId },
        value: Buffer.from(`${ownerId}-api-key`),
      },
      {
        descriptor: { ...CREDENTIALS.cacheServerSettings, ownerId },
        value: Buffer.from(`${ownerId}-headers`),
      },
    ];

    let markFirstMutationStarted!: () => void;
    const firstMutationStarted = new Promise<void>((resolve) => {
      markFirstMutationStarted = resolve;
    });
    let allowFirstFailure!: () => void;
    const firstFailureAllowed = new Promise<void>((resolve) => {
      allowFirstFailure = resolve;
    });
    const first = service.setMany(entries("first"), async () => {
      markFirstMutationStarted();
      await firstFailureAllowed;
      throw new Error("first metadata failure");
    });
    const firstFailure = expect(first).rejects.toThrow(
      "first metadata failure",
    );
    await firstMutationStarted;

    const second = service.setMany(entries("second"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(operations).not.toContain(
      `set:${CREDENTIALS.cacheServerApiKey.id}:second-api-key`,
    );

    allowFirstFailure();
    await firstFailure;
    await expect(second).resolves.toBeUndefined();

    expect(
      Buffer.from(values.get(CREDENTIALS.cacheServerApiKey.id)!).toString(
        "utf8",
      ),
    ).toBe("second-api-key");
    expect(
      Buffer.from(values.get(CREDENTIALS.cacheServerSettings.id)!).toString(
        "utf8",
      ),
    ).toBe("second-headers");
    const rows = await prisma.credential.findMany({
      where: {
        id: {
          in: [
            CREDENTIALS.cacheServerApiKey.id,
            CREDENTIALS.cacheServerSettings.id,
          ],
        },
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.ownerId === "second")).toBe(true);
  });

  test("rolls back mixed external sets and deletes when metadata fails", async () => {
    const values = new Map<string, Uint8Array>();
    const service = new CredentialService({
      env: { CREDENTIAL_STORAGE_TYPE: "keychain" },
      platform: "darwin",
      prisma,
      keychainModuleLoader: async () => ({
        AsyncEntry: class {
          constructor(
            readonly _service: string,
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
      }),
    });
    const bundle = apnsCertificateCredential("certificate-1");
    await service.setMany([
      {
        descriptor: CREDENTIALS.apnsCertificateCatalog,
        value: Buffer.from("old-catalog"),
      },
      { descriptor: bundle, value: Buffer.from("old-bundle") },
    ]);

    await expect(
      service.setAndDeleteMany(
        [
          {
            descriptor: CREDENTIALS.apnsCertificateCatalog,
            value: Buffer.from("new-catalog"),
          },
        ],
        [bundle],
        async () => {
          throw new Error("metadata failed");
        },
      ),
    ).rejects.toThrow("metadata failed");
    expect(
      Buffer.from(values.get(CREDENTIALS.apnsCertificateCatalog.id)!).toString(
        "utf8",
      ),
    ).toBe("old-catalog");
    expect(Buffer.from(values.get(bundle.id)!).toString("utf8")).toBe(
      "old-bundle",
    );
    expect(await prisma.credential.count()).toBe(2);
  });
});

type VaultSecret = { kind: string; ownerId: string | null; value: string };

// Serves KV v2 reads and metadata listings from a plain map so the service exercises the
// real Vault driver, including the folder walk adoption depends on.
function vaultBackend(
  secrets: Map<string, VaultSecret>,
  backendOptions: { denyList?: boolean } = {},
) {
  const PREFIX = "/v1/secret/data/ai-development-environment/credentials/";
  const LIST_PREFIX =
    "/v1/secret/metadata/ai-development-environment/credentials";
  const json = (statusCode: number, body: unknown = {}) => ({
    statusCode,
    body: { text: async () => JSON.stringify(body) },
  });
  const request = vi.fn(async (url: string, options: { method: string }) => {
    const path = new URL(url);
    if (path.searchParams.get("list") === "true") {
      if (backendOptions.denyList) return json(403);
      const folder = path.pathname.slice(LIST_PREFIX.length).replace(/^\//, "");
      const children = new Set<string>();
      for (const id of secrets.keys()) {
        if (folder && !id.startsWith(`${folder}/`)) continue;
        const rest = folder ? id.slice(folder.length + 1) : id;
        const [head, ...tail] = rest.split("/");
        children.add(tail.length ? `${head}/` : head);
      }
      return children.size
        ? json(200, { data: { keys: [...children] } })
        : json(404);
    }
    const id = decodeURIComponent(path.pathname.slice(PREFIX.length));
    if (options.method !== "GET") return json(204);
    const secret = secrets.get(id);
    return secret
      ? json(200, {
          data: {
            data: {
              value: Buffer.from(secret.value).toString("base64"),
              version: 1,
              kind: secret.kind,
              ownerId: secret.ownerId,
            },
          },
        })
      : json(404);
  });
  return request;
}

describe("CredentialService vault backend", () => {
  let directory: string;
  let prisma: InstanceType<typeof PrismaClient>;

  beforeEach(async () => {
    resetCredentialAdoptionForTests();
    directory = await mkdtemp(join(tmpdir(), "ade-credentials-vault-"));
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: join(directory, "test.db") }),
    });
    await prisma.$executeRawUnsafe(CREATE_CREDENTIAL_TABLE);
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });

  const env = (overrides: Record<string, string> = {}) => ({
    CREDENTIAL_STORAGE_TYPE: "vault",
    VAULT_ADDR: "https://vault.test",
    VAULT_TOKEN: "vault-token-secret",
    ...overrides,
  });

  test("adopts credentials Vault already holds on a cold database", async () => {
    const request = vaultBackend(
      new Map([
        [
          CREDENTIALS.jiraApiToken.id,
          {
            kind: CREDENTIALS.jiraApiToken.kind,
            ownerId: "default",
            value: "jira-secret",
          },
        ],
      ]),
    );
    const service = new CredentialService({
      env: env(),
      prisma,
      vaultRequest: request as never,
      vaultDispatcherFactory: () => ({}) as never,
    });

    await expect(service.isConfigured(CREDENTIALS.jiraApiToken)).resolves.toBe(
      true,
    );
    await expect(service.getText(CREDENTIALS.jiraApiToken)).resolves.toBe(
      "jira-secret",
    );
    await expect(
      service.isConfigured(CREDENTIALS.githubPersonalAccessToken),
    ).resolves.toBe(false);
    await expect(service.status()).resolves.toMatchObject({
      storageType: "vault",
      readOnly: false,
      adoptedCount: 1,
      itemCount: 1,
      mismatchCount: 0,
    });
    const row = await prisma.credential.findUniqueOrThrow({
      where: { id: CREDENTIALS.jiraApiToken.id },
    });
    expect(row).toMatchObject({ storageType: "vault", payload: null });
  });

  test("lazily adopts an explicitly requested dynamic credential", async () => {
    const descriptor = apnsCertificateCredential("certificate-7");
    const value = { p12Base64: "bundle", passphrase: "passphrase" };
    const request = vaultBackend(
      new Map([
        [
          descriptor.id,
          {
            kind: descriptor.kind,
            ownerId: descriptor.ownerId ?? null,
            value: encodeJsonCredential(value).toString("utf8"),
          },
        ],
      ]),
      { denyList: true },
    );
    const service = new CredentialService({
      env: env(),
      prisma,
      vaultRequest: request as never,
      vaultDispatcherFactory: () => ({}) as never,
    });

    await expect(service.getJson(descriptor)).resolves.toEqual(value);
    await expect(
      prisma.credential.findUniqueOrThrow({ where: { id: descriptor.id } }),
    ).resolves.toMatchObject({
      kind: descriptor.kind,
      ownerId: descriptor.ownerId,
      storageType: "vault",
    });
  });

  test("refuses to change credentials on a read-only install", async () => {
    const request = vaultBackend(
      new Map([
        [
          CREDENTIALS.jiraApiToken.id,
          {
            kind: CREDENTIALS.jiraApiToken.kind,
            ownerId: "default",
            value: "jira-secret",
          },
        ],
      ]),
    );
    const service = new CredentialService({
      env: env({ CREDENTIAL_VAULT_READ_ONLY: "true" }),
      prisma,
      vaultRequest: request as never,
      vaultDispatcherFactory: () => ({}) as never,
    });

    await expect(service.getText(CREDENTIALS.jiraApiToken)).resolves.toBe(
      "jira-secret",
    );
    await expect(
      service.setText(CREDENTIALS.jiraApiToken, "replacement"),
    ).rejects.toMatchObject({ code: "CREDENTIAL_STORE_READ_ONLY" });
    await expect(
      service.delete(CREDENTIALS.jiraApiToken),
    ).rejects.toMatchObject({ code: "CREDENTIAL_STORE_READ_ONLY" });
    await expect(service.status()).resolves.toMatchObject({ readOnly: true });
    expect(
      request.mock.calls.every(([, options]) => options.method === "GET"),
    ).toBe(true);
    await expect(service.getText(CREDENTIALS.jiraApiToken)).resolves.toBe(
      "jira-secret",
    );
  });

  test("runs one adoption pass no matter how many services are constructed", async () => {
    const request = vaultBackend(
      new Map([
        [
          CREDENTIALS.jiraApiToken.id,
          {
            kind: CREDENTIALS.jiraApiToken.kind,
            ownerId: "default",
            value: "jira-secret",
          },
        ],
      ]),
    );
    const build = () =>
      new CredentialService({
        env: env(),
        prisma,
        vaultRequest: request as never,
        vaultDispatcherFactory: () => ({}) as never,
      });

    await Promise.all([
      build().isConfigured(CREDENTIALS.jiraApiToken),
      build().isConfigured(CREDENTIALS.jiraApiToken),
      build().list(),
    ]);

    const listCalls = request.mock.calls.filter(([url]) =>
      String(url).includes("list=true"),
    );
    expect(listCalls.length).toBeGreaterThan(0);
    const rootListCalls = listCalls.filter(([url]) =>
      String(url).endsWith("credentials?list=true"),
    );
    expect(rootListCalls).toHaveLength(1);
  });
});
