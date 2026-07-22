// @vitest-environment node
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const LEGACY_SCHEMA = `
CREATE TABLE "IosDeviceSettings" (
  "id" TEXT PRIMARY KEY, "organizationName" TEXT NOT NULL,
  "profileIdentifier" TEXT NOT NULL, "signerCertificatePem" TEXT,
  "signerPrivateKeyPem" TEXT, "signerFingerprint" TEXT,
  "signerCreatedAt" DATETIME, "signerExpiresAt" DATETIME,
  "appStoreConnectIssuerId" TEXT, "appStoreConnectKeyId" TEXT,
  "appStoreConnectPrivateKey" TEXT,
  "appStoreConnectPrivateKeyFingerprint" TEXT,
  "appStoreConnectVerifiedAt" DATETIME,
  "appStoreConnectLastTestedAt" DATETIME,
  "appStoreConnectVerificationError" TEXT,
  "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "PushNotificationSettings" (
  "id" TEXT PRIMARY KEY, "tokenTeamId" TEXT, "tokenKeyId" TEXT,
  "tokenPrivateKey" TEXT, "tokenPrivateKeyFingerprint" TEXT,
  "tokenConfiguredAt" DATETIME, "tokenLastUsedAt" DATETIME,
  "tokenLastError" TEXT, "createdAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "ApnsCertificateCredential" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "topic" TEXT NOT NULL,
  "environment" TEXT NOT NULL, "p12Base64" TEXT NOT NULL,
  "passphrase" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
  "expiresAt" DATETIME, "lastTestedAt" DATETIME, "lastError" TEXT,
  "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "ExternalMcpServer" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "url" TEXT NOT NULL,
  "transport" TEXT NOT NULL, "toolNamePrefix" TEXT NOT NULL DEFAULT '',
  "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "ExternalMcpServerHeader" (
  "id" TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "value" TEXT NOT NULL, "createdAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  FOREIGN KEY ("serverId") REFERENCES "ExternalMcpServer"("id") ON DELETE CASCADE
);
CREATE TABLE "JiraSettings" (
  "id" TEXT PRIMARY KEY, "siteUrl" TEXT, "email" TEXT, "apiToken" TEXT,
  "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 300,
  "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "GitHubSettings" (
  "id" TEXT PRIMARY KEY, "apiToken" TEXT,
  "defaultJiraKeyRegex" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "GitHubAppSettings" (
  "id" TEXT PRIMARY KEY, "appId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL, "privateKey" TEXT NOT NULL,
  "apiBaseUrl" TEXT NOT NULL, "graphqlUrl" TEXT NOT NULL,
  "keyFingerprint" TEXT NOT NULL, "appSlug" TEXT NOT NULL,
  "accountLogin" TEXT NOT NULL, "repositorySelection" TEXT NOT NULL,
  "actionsPermission" TEXT NOT NULL, "verifiedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "CacheServerSettings" (
  "id" TEXT PRIMARY KEY, "baseUrl" TEXT, "apiKey" TEXT,
  "headersJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
);
`;

describe("credential storage migration", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("purges legacy secrets while retaining usable non-secret settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ade-migration-"));
    directories.push(directory);
    const database = new Database(join(directory, "legacy.db"));
    try {
      database.exec(LEGACY_SCHEMA);
      const now = "2026-07-21T00:00:00.000Z";
      database
        .prepare(
          `INSERT INTO IosDeviceSettings VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          "default",
          "Example Org",
          "com.example.enrollment",
          "certificate",
          "signer-secret",
          "signer-fingerprint",
          "issuer",
          "key-id",
          "app-store-secret",
          "app-fingerprint",
          now,
          now,
        );
      database
        .prepare(
          `INSERT INTO PushNotificationSettings VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          "default",
          "TEAM",
          "KEY",
          "apns-token-secret",
          "token-fingerprint",
          now,
          now,
        );
      database
        .prepare(
          `INSERT INTO ApnsCertificateCredential VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          "certificate-1",
          "Certificate",
          "com.example.app",
          "SANDBOX",
          "p12-secret",
          "passphrase-secret",
          "certificate-fingerprint",
          now,
          now,
        );
      database
        .prepare(`INSERT INTO ExternalMcpServer VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "mcp-1",
          "MCP",
          "https://mcp.example.com",
          "STREAMABLE_HTTP",
          "",
          now,
          now,
        );
      database
        .prepare(
          `INSERT INTO ExternalMcpServerHeader VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("header-1", "mcp-1", "Authorization", "header-secret", now, now);
      database
        .prepare(`INSERT INTO JiraSettings VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "default",
          "https://example.atlassian.net",
          "user@example.com",
          "jira-secret",
          300,
          now,
          now,
        );
      database
        .prepare(`INSERT INTO GitHubSettings VALUES (?, ?, ?, ?, ?)`)
        .run("default", "github-secret", "regex", now, now);
      database
        .prepare(
          `INSERT INTO GitHubAppSettings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "default",
          "1",
          "2",
          "github-app-secret",
          "https://api.github.com",
          "https://api.github.com/graphql",
          "fingerprint",
          "app",
          "account",
          "selected",
          "write",
          now,
          now,
          now,
        );
      database
        .prepare(`INSERT INTO CacheServerSettings VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          "default",
          "https://cache.example.com",
          "cache-secret",
          '[{"name":"Authorization","value":"header-secret"}]',
          now,
          now,
        );

      const migration = await readFile(
        join(
          process.cwd(),
          "prisma/migrations/20260721220000_add_credential_storage/migration.sql",
        ),
        "utf8",
      );
      database.exec(migration);

      const columns = (table: string) =>
        (
          database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).map(({ name }) => name);
      expect(columns("IosDeviceSettings")).not.toEqual(
        expect.arrayContaining([
          "signerPrivateKeyPem",
          "appStoreConnectPrivateKey",
        ]),
      );
      expect(columns("PushNotificationSettings")).not.toContain(
        "tokenPrivateKey",
      );
      expect(columns("ApnsCertificateCredential")).not.toEqual(
        expect.arrayContaining(["p12Base64", "passphrase"]),
      );
      expect(columns("ExternalMcpServerHeader")).not.toContain("value");
      expect(columns("JiraSettings")).not.toContain("apiToken");
      expect(columns("GitHubSettings")).not.toContain("apiToken");
      expect(columns("GitHubAppSettings")).not.toContain("privateKey");
      expect(columns("CacheServerSettings")).not.toEqual(
        expect.arrayContaining(["apiKey", "headersJson"]),
      );

      expect(
        database.prepare("SELECT COUNT(*) AS count FROM Credential").get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT organizationName, appStoreConnectIssuerId FROM IosDeviceSettings",
          )
          .get(),
      ).toEqual({
        organizationName: "Example Org",
        appStoreConnectIssuerId: "issuer",
      });
      expect(
        database.prepare("SELECT name FROM ExternalMcpServerHeader").get(),
      ).toEqual({ name: "Authorization" });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM ApnsCertificateCredential")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare("SELECT baseUrl, headerNamesJson FROM CacheServerSettings")
          .get(),
      ).toEqual({
        baseUrl: "https://cache.example.com",
        headerNamesJson: "[]",
      });
    } finally {
      database.close();
    }
  });
});
