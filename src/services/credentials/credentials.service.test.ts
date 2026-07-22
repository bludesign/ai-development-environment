// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

import { CredentialService } from "./credentials.service";
import { CREDENTIALS } from "./types";

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
  let prisma: InstanceType<typeof PrismaClient>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ade-credentials-"));
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: join(directory, "test.db") }),
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
    await expect(missing.status()).resolves.toMatchObject({
      state: "ERROR",
      encryptionState: "ERROR",
    });

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
});
