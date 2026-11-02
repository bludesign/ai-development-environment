import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("preserves old build boundaries and permits independently deduplicated runs", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE BuildDeployment (id TEXT PRIMARY KEY);
      CREATE TABLE JiraProject (id TEXT PRIMARY KEY);
      CREATE TABLE TelemetryViewSettings (id TEXT PRIMARY KEY);
      CREATE TABLE TelemetryEntry (
        id TEXT PRIMARY KEY, entryType TEXT, separatorKind TEXT,
        buildId TEXT, separatorName TEXT, clientTime TEXT
      );
      CREATE UNIQUE INDEX TelemetryEntry_separatorKind_buildId_key ON TelemetryEntry(separatorKind, buildId);
      INSERT INTO TelemetryViewSettings VALUES ('analytics');
      INSERT INTO TelemetryEntry VALUES
        ('created', 'SEPARATOR', 'BUILD', 'build-1', 'Debug on iPhone', '2026-10-30T12:00:00Z'),
        ('manual', 'SEPARATOR', 'MANUAL', NULL, 'Investigation', '2026-10-30T12:01:00Z'),
        ('event', 'ANALYTICS', NULL, 'build-1', NULL, '2026-10-30T12:02:00Z');
    `);
    db.exec(
      readFileSync(
        resolve(
          "prisma/migrations/20261102150000_build_run_telemetry_and_jira_resolution/migration.sql",
        ),
        "utf8",
      ),
    );
    expect(
      db.prepare("SELECT * FROM TelemetryEntry WHERE id = 'created'").get(),
    ).toMatchObject({
      separatorKind: "BUILD_CREATED",
      separatorKey: "build-created:build-1",
      separatorName: "Debug on iPhone",
      clientTime: "2026-10-30T12:00:00Z",
    });
    expect(
      db
        .prepare(
          "SELECT separatorKind, separatorKey FROM TelemetryEntry WHERE id = 'manual'",
        )
        .get(),
    ).toEqual({ separatorKind: "MANUAL", separatorKey: null });
    expect(
      db.prepare("SELECT buildId FROM TelemetryEntry WHERE id = 'event'").get(),
    ).toEqual({ buildId: "build-1" });
    expect(
      db
        .prepare("SELECT showBuildRunSeparators FROM TelemetryViewSettings")
        .get(),
    ).toEqual({ showBuildRunSeparators: 1 });
    const insert = db.prepare(
      "INSERT INTO TelemetryEntry (id, entryType, separatorKind, buildId, separatorKey) VALUES (?, 'SEPARATOR', 'BUILD_RUN', 'build-1', ?)",
    );
    insert.run("run-1", "build-run:batch-1");
    insert.run("run-2", "build-run:batch-2");
    expect(() => insert.run("retry", "build-run:batch-1")).toThrow(/UNIQUE/);
  } finally {
    db.close();
  }
});
