// @vitest-environment node
import { describe, expect, test } from "vitest";

import { sqlitePathFromDatabaseUrl } from "./prisma-client";

describe("sqlitePathFromDatabaseUrl", () => {
  test("returns the path from a SQLite file URL", () => {
    expect(sqlitePathFromDatabaseUrl("file:./prisma/dev.db")).toBe(
      "./prisma/dev.db",
    );
  });

  test.each([
    "postgresql://user:secret@localhost/database",
    "mysql://user:secret@localhost/database",
  ])("rejects the unsupported URL scheme in %s", (url) => {
    expect(() => sqlitePathFromDatabaseUrl(url)).toThrow(
      "This build supports SQLite file: URLs only",
    );
  });
});
