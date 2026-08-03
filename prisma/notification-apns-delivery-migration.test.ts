// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

let database: Database.Database | null = null;

function migrate(instance: Database.Database): void {
  instance.exec(
    readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260802220000_add_notification_apns_delivery/migration.sql",
      ),
      "utf8",
    ),
  );
}

afterEach(() => {
  database?.close();
  database = null;
});

describe("notification APNs delivery migration", () => {
  test("adopts the browser channel for saved preferences and leaves history opted out", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "NotificationPreference" (
        "typeKey" TEXT NOT NULL PRIMARY KEY,
        "sidebarEnabled" BOOLEAN NOT NULL,
        "browserEnabled" BOOLEAN NOT NULL,
        "webPushEnabled" BOOLEAN NOT NULL
      );
      CREATE TABLE "AppNotification" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "sidebarRequested" BOOLEAN NOT NULL,
        "browserRequested" BOOLEAN NOT NULL,
        "webPushRequested" BOOLEAN NOT NULL
      );
      INSERT INTO "NotificationPreference"
        ("typeKey", "sidebarEnabled", "browserEnabled", "webPushEnabled")
        VALUES ('RUN_COMPLETED', 1, 1, 1), ('RUN_CANCELLED', 1, 0, 0);
      INSERT INTO "AppNotification"
        ("id", "sidebarRequested", "browserRequested", "webPushRequested")
        VALUES ('notification-1', 1, 1, 1);
    `);

    migrate(database);

    expect(
      database
        .prepare(
          `SELECT "typeKey", "apnsEnabled" FROM "NotificationPreference" ORDER BY "typeKey"`,
        )
        .all(),
    ).toEqual([
      { typeKey: "RUN_CANCELLED", apnsEnabled: 0 },
      { typeKey: "RUN_COMPLETED", apnsEnabled: 1 },
    ]);
    expect(
      database
        .prepare(`SELECT "apnsRequested" FROM "AppNotification" WHERE "id" = ?`)
        .get("notification-1"),
    ).toEqual({ apnsRequested: 0 });
  });

  test("keeps one row per client registration and per device token", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "NotificationPreference" (
        "typeKey" TEXT NOT NULL PRIMARY KEY,
        "sidebarEnabled" BOOLEAN NOT NULL,
        "browserEnabled" BOOLEAN NOT NULL,
        "webPushEnabled" BOOLEAN NOT NULL
      );
      CREATE TABLE "AppNotification" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "sidebarRequested" BOOLEAN NOT NULL,
        "browserRequested" BOOLEAN NOT NULL,
        "webPushRequested" BOOLEAN NOT NULL
      );
    `);

    migrate(database);

    const insert = database.prepare(`
      INSERT INTO "NotificationDevice"
        ("id", "clientRegistrationId", "token", "tokenHash", "topic", "environment",
         "displayName", "updatedAt")
        VALUES (?, ?, ?, ?, 'com.example.app', 'SANDBOX', 'iPhone', CURRENT_TIMESTAMP)
    `);
    insert.run("device-1", "client-1", "TOKEN-1", "hash-1");

    expect(() =>
      insert.run("device-2", "client-1", "TOKEN-2", "hash-2"),
    ).toThrow(/UNIQUE/);
    expect(() =>
      insert.run("device-3", "client-2", "TOKEN-1", "hash-1"),
    ).toThrow(/UNIQUE/);

    insert.run("device-4", "client-2", "TOKEN-2", "hash-2");
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM "NotificationDevice"`)
        .get(),
    ).toEqual({ count: 2 });
  });

  test("defaults new devices to active", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "NotificationPreference" (
        "typeKey" TEXT NOT NULL PRIMARY KEY,
        "sidebarEnabled" BOOLEAN NOT NULL,
        "browserEnabled" BOOLEAN NOT NULL,
        "webPushEnabled" BOOLEAN NOT NULL
      );
      CREATE TABLE "AppNotification" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "sidebarRequested" BOOLEAN NOT NULL,
        "browserRequested" BOOLEAN NOT NULL,
        "webPushRequested" BOOLEAN NOT NULL
      );
    `);

    migrate(database);

    database
      .prepare(
        `INSERT INTO "NotificationDevice"
          ("id", "clientRegistrationId", "token", "tokenHash", "topic", "environment",
           "displayName", "updatedAt")
          VALUES ('device-1', 'client-1', 'TOKEN', 'hash', 'com.example.app', 'PRODUCTION',
                  'iPhone', CURRENT_TIMESTAMP)`,
      )
      .run();

    expect(
      database
        .prepare(`SELECT "status" FROM "NotificationDevice" WHERE "id" = ?`)
        .get("device-1"),
    ).toEqual({ status: "ACTIVE" });
  });
});
