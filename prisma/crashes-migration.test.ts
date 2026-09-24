// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

let database: Database.Database | null = null;

afterEach(() => {
  database?.close();
  database = null;
});

function migrate(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE "Agent" ("id" TEXT NOT NULL PRIMARY KEY);
    CREATE TABLE "Build" ("id" TEXT NOT NULL PRIMARY KEY);
    CREATE TABLE "BuildArtifact" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "buildId" TEXT NOT NULL,
      CONSTRAINT "BuildArtifact_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build" ("id") ON DELETE CASCADE
    );
  `);
  db.exec(
    readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260923200000_add_crashes/migration.sql",
      ),
      "utf8",
    ),
  );
  return db;
}

function insertCrash(db: Database.Database, id: string, payloadIndex = 0) {
  db.prepare(
    `INSERT INTO "CrashReport" ("id", "format", "source", "filename", "storagePath", "sha256", "payloadIndex", "sizeBytes", "signature", "signatureTitle", "normalizedJson", "updatedAt")
     VALUES (?, 'IPS', 'API', 'a.ips', 'reports/a.ips', 'same-digest', ?, 10, 'sig', 'title', '{}', CURRENT_TIMESTAMP)`,
  ).run(id, payloadIndex);
}

function insertDsym(db: Database.Database) {
  db.prepare(`INSERT INTO "Build" ("id") VALUES ('build-1')`).run();
  db.prepare(
    `INSERT INTO "BuildArtifact" ("id", "buildId") VALUES ('artifact-1', 'build-1')`,
  ).run();
  db.prepare(
    `INSERT INTO "DsymUpload" ("id", "filename", "sizeBytes", "source", "linkedBuildId", "buildArtifactId", "updatedAt")
     VALUES ('upload-1', 'dSYMs.zip', 10, 'BUILD', 'build-1', 'artifact-1', CURRENT_TIMESTAMP)`,
  ).run();
  db.prepare(
    `INSERT INTO "Dsym" ("id", "uploadId", "bundleName", "binaryName", "dwarfPath", "dwarfSha256", "dwarfSizeBytes")
     VALUES ('dsym-1', 'upload-1', 'App.app.dSYM', 'App', 'dsyms/upload-1/App', 'digest', 10)`,
  ).run();
  db.prepare(
    `INSERT INTO "DsymSlice" ("id", "dsymId", "uuid", "arch", "textVmAddr")
     VALUES ('slice-1', 'dsym-1', 'ABC', 'arm64', '0x100000000')`,
  ).run();
}

describe("crashes migration", () => {
  test("dedupes a crash per payload position, not per upload", () => {
    database = migrate();
    insertCrash(database, "crash-1", 0);
    insertCrash(database, "crash-2", 1);
    expect(() => insertCrash(database!, "crash-3", 0)).toThrow(/UNIQUE/);
  });

  test("keeps crashes when their dSYM is deleted and cascades the rest", () => {
    database = migrate();
    insertDsym(database);
    insertCrash(database, "crash-1");
    database
      .prepare(
        `INSERT INTO "CrashBinaryImage" ("id", "crashId", "imageIndex", "uuid", "name", "dsymId")
         VALUES ('image-1', 'crash-1', 0, 'ABC', 'App', 'dsym-1')`,
      )
      .run();

    database.prepare(`DELETE FROM "DsymUpload" WHERE "id" = 'upload-1'`).run();
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM "DsymSlice"`).get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(`SELECT "dsymId" FROM "CrashBinaryImage" WHERE "id" = ?`)
        .get("image-1"),
    ).toEqual({ dsymId: null });

    database.prepare(`DELETE FROM "CrashReport" WHERE "id" = 'crash-1'`).run();
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM "CrashBinaryImage"`)
        .get(),
    ).toEqual({ count: 0 });
  });

  test("keeps imported dSYMs when their build is deleted", () => {
    database = migrate();
    insertDsym(database);
    database.prepare(`DELETE FROM "Build" WHERE "id" = 'build-1'`).run();
    expect(
      database
        .prepare(
          `SELECT "linkedBuildId", "buildArtifactId" FROM "DsymUpload" WHERE "id" = 'upload-1'`,
        )
        .get(),
    ).toEqual({ linkedBuildId: null, buildArtifactId: null });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM "Dsym"`).get(),
    ).toEqual({ count: 1 });
  });

  test("clears the preferred symbolication agent when it is removed", () => {
    database = migrate();
    database.prepare(`INSERT INTO "Agent" ("id") VALUES ('agent-1')`).run();
    database
      .prepare(
        `INSERT INTO "CrashSettings" ("id", "symbolicationAgentId", "updatedAt") VALUES ('default', 'agent-1', CURRENT_TIMESTAMP)`,
      )
      .run();
    database.prepare(`DELETE FROM "Agent" WHERE "id" = 'agent-1'`).run();
    expect(
      database
        .prepare(
          `SELECT "symbolicationAgentId", "collectionEnabled", "retentionDays" FROM "CrashSettings"`,
        )
        .get(),
    ).toEqual({
      symbolicationAgentId: null,
      collectionEnabled: 1,
      retentionDays: 90,
    });
  });
});
