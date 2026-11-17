import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("status subscriptions are owner-scoped and removed when their session is revoked", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE "user" (id TEXT PRIMARY KEY);
      CREATE TABLE "session" (id TEXT PRIMARY KEY);
      INSERT INTO "user" VALUES ('user-1'), ('user-2');
      INSERT INTO "session" VALUES ('session-1'), ('session-2');
    `);
    database.exec(
      readFileSync(
        resolve(
          process.cwd(),
          "prisma/migrations/20261117150000_ios_status_subscriptions/migration.sql",
        ),
        "utf8",
      ),
    );
    const insert = database.prepare(`
      INSERT INTO "IosStatusSubscription"
      (id, userId, sessionId, clientRegistrationId, kind, token, topic, environment, expiresAt, updatedAt)
      VALUES (?, ?, ?, 'widget-1', 'WIDGET', 'TOKEN', 'com.example.app', 'SANDBOX', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    insert.run("subscription-1", "user-1", "session-1");
    expect(() => insert.run("duplicate", "user-1", "session-1")).toThrow(
      /UNIQUE/,
    );
    insert.run("subscription-2", "user-2", "session-2");
    database.prepare('DELETE FROM "session" WHERE id = ?').run("session-1");
    expect(
      database.prepare('SELECT id FROM "IosStatusSubscription"').all(),
    ).toEqual([{ id: "subscription-2" }]);
    database.prepare('DELETE FROM "user" WHERE id = ?').run("user-2");
    expect(
      database.prepare('SELECT id FROM "IosStatusSubscription"').all(),
    ).toEqual([]);
  } finally {
    database.close();
  }
});
