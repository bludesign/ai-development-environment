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

describe("tool-call audit migration", () => {
  test("creates query indexes without storing raw arguments or error text", () => {
    database = new Database(":memory:");
    database.exec(
      readFileSync(
        resolve(
          process.cwd(),
          "prisma/migrations/20260726130000_add_tool_call_audit/migration.sql",
        ),
        "utf8",
      ),
    );

    const columns = database
      .prepare(`PRAGMA table_info("ToolCallAudit")`)
      .all()
      .map((column) => (column as { name: string }).name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "correlationId",
        "caller",
        "argumentsSha256",
        "resultStatus",
        "durationMs",
      ]),
    );
    expect(columns).not.toEqual(expect.arrayContaining(["arguments", "error"]));

    const indexes = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ToolCallAudit'`,
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "ToolCallAudit_startedAt_idx",
        "ToolCallAudit_toolName_startedAt_idx",
        "ToolCallAudit_correlationId_idx",
        "ToolCallAudit_resultStatus_startedAt_idx",
      ]),
    );
  });
});
