// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

import { adoptExternalCredentials } from "./adoption";
import { DatabaseCredentialDriver } from "./database-driver";
import type { AdoptableCredential, CredentialDriver } from "./driver";
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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;

type FakeVaultOptions = {
  stored?: Record<string, AdoptableCredential>;
  list?: () => Promise<string[]>;
  describe?: (id: string) => Promise<AdoptableCredential | null>;
};

function fakeVault(options: FakeVaultOptions = {}): CredentialDriver {
  const stored = options.stored ?? {};
  return {
    storageType: "vault",
    readOnly: false,
    initialize: async () => {},
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    describe: options.describe ?? (async (id) => stored[id] ?? null),
    list: options.list ?? (async () => Object.keys(stored)),
  };
}

function adoptable(
  descriptor: (typeof CREDENTIALS)[keyof typeof CREDENTIALS],
): AdoptableCredential {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    ownerId: descriptor.ownerId,
  };
}

describe("adoptExternalCredentials", () => {
  let directory: string;
  let prisma: InstanceType<typeof PrismaClient>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ade-adoption-"));
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: join(directory, "test.db") }),
    });
    await prisma.$executeRawUnsafe(CREATE_CREDENTIAL_TABLE);
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });

  test("rebuilds metadata for secrets the database has never seen", async () => {
    const driver = fakeVault({
      stored: {
        [CREDENTIALS.jiraApiToken.id]: adoptable(CREDENTIALS.jiraApiToken),
        "external-mcp-server/server-7/headers": {
          id: "external-mcp-server/server-7/headers",
          kind: "external-mcp-server-headers",
          ownerId: "server-7",
        },
      },
    });

    await expect(
      adoptExternalCredentials(prisma, driver),
    ).resolves.toMatchObject({ adopted: 2, issue: null });
    const rows = await prisma.credential.findMany({ orderBy: { id: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "external-mcp-server/server-7/headers",
      kind: "external-mcp-server-headers",
      ownerId: "server-7",
      storageType: "vault",
      encrypted: false,
      payload: null,
    });
    expect(rows[1]).toMatchObject({
      id: CREDENTIALS.jiraApiToken.id,
      storageType: "vault",
    });
  });

  test("leaves a credential recorded under another backend untouched", async () => {
    await prisma.credential.create({
      data: {
        id: CREDENTIALS.jiraApiToken.id,
        kind: CREDENTIALS.jiraApiToken.kind,
        ownerId: "default",
        storageType: "database",
        payload: Buffer.from("database-secret"),
        updatedAt: new Date(),
      },
    });
    const describe = vi.fn(async () => adoptable(CREDENTIALS.jiraApiToken));

    await expect(
      adoptExternalCredentials(
        prisma,
        fakeVault({ describe, list: async () => [] }),
      ),
    ).resolves.toMatchObject({ adopted: 0 });
    expect(describe).not.toHaveBeenCalledWith(CREDENTIALS.jiraApiToken.id);
    const row = await prisma.credential.findUniqueOrThrow({
      where: { id: CREDENTIALS.jiraApiToken.id },
    });
    expect(row.storageType).toBe("database");
    expect(Buffer.from(row.payload!).toString("utf8")).toBe("database-secret");
  });

  test("skips entries the backend cannot describe as a known credential", async () => {
    const driver = fakeVault({
      list: async () => ["unrelated/default/secret"],
      describe: async (id) =>
        id === "unrelated/default/secret"
          ? Promise.reject(new Error("invalid credential payload"))
          : null,
    });

    await expect(
      adoptExternalCredentials(prisma, driver),
    ).resolves.toMatchObject({ adopted: 0, issue: null });
    expect(await prisma.credential.count()).toBe(0);
  });

  test("falls back to the static descriptors when listing is denied", async () => {
    const describe = vi.fn(async (id: string) =>
      id === CREDENTIALS.githubAppPrivateKey.id
        ? adoptable(CREDENTIALS.githubAppPrivateKey)
        : null,
    );
    const driver = fakeVault({
      describe,
      list: async () => {
        throw new Error("Vault credential list failed (HTTP 403)");
      },
    });

    await expect(
      adoptExternalCredentials(prisma, driver),
    ).resolves.toMatchObject({ adopted: 1, issue: null });
    expect(describe.mock.calls.map(([id]) => id)).toEqual(
      expect.arrayContaining([
        CREDENTIALS.jiraApiToken.id,
        CREDENTIALS.githubAppPrivateKey.id,
      ]),
    );
    await expect(
      prisma.credential.findUniqueOrThrow({
        where: { id: CREDENTIALS.githubAppPrivateKey.id },
      }),
    ).resolves.toMatchObject({ storageType: "vault" });
  });

  test("reports a failed pass instead of throwing", async () => {
    const driver = fakeVault({
      list: async () => [CREDENTIALS.jiraApiToken.id],
      describe: async () => {
        throw Object.assign(new Error("vault unreachable"), {
          name: "AbortError",
        });
      },
    });
    // A describe failure is skipped per entry, so force the pass itself to fail.
    vi.spyOn(prisma.credential, "findMany").mockRejectedValueOnce(
      new Error("database is locked"),
    );

    await expect(
      adoptExternalCredentials(prisma, driver),
    ).resolves.toMatchObject({
      adopted: 0,
      issue: {
        code: "VAULT_ADOPTION_FAILED",
        message: expect.stringContaining("database is locked"),
      },
    });
  });

  test("does nothing for a backend that owns its own metadata", async () => {
    const driver = new DatabaseCredentialDriver(prisma, {
      storageType: "database",
      encryptionKey: null,
      keyFingerprint: null,
    });

    await expect(adoptExternalCredentials(prisma, driver)).resolves.toEqual({
      adopted: 0,
      skipped: 0,
      issue: null,
    });
  });
});
