import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "../../src/generated/prisma/client";

const DEFAULT_MOCK_DATABASE_URL = "file:./prisma/mock.db";

/**
 * Resolve the SQLite file path the mock seed writes to. Mirrors
 * src/data/prisma-client.ts but without the `server-only` guard so it can run in a
 * plain tsx script. Defaults to prisma/mock.db to keep the real dev database untouched.
 */
export function mockDatabasePath(): string {
  const url = process.env.DATABASE_URL || DEFAULT_MOCK_DATABASE_URL;
  if (!/^file:/i.test(url)) {
    throw new Error(
      `Mock seeding only supports SQLite file: URLs, received "${url}".`,
    );
  }
  return url.replace(/^file:/i, "");
}

export function createMockPrismaClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: mockDatabasePath() });
  return new PrismaClient({ adapter });
}
