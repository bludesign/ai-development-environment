import path from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "../../src/generated/prisma/client";

const DEFAULT_MOCK_DATABASE_URL = "file:./prisma/mock.db";
const MOCK_DATABASE_FILENAME = "mock.db";

/**
 * Resolve the SQLite file path the mock seed writes to. Mirrors
 * src/data/prisma-client.ts but without the `server-only` guard so it can run in a
 * plain tsx script. Defaults to prisma/mock.db to keep the real dev database untouched.
 *
 * DATABASE_URL is honoured, but only when it names a `mock.db` file. The seeders assume an
 * empty database and write generic "Acme" rows, so pointing them at dev.db — or at the
 * Homebrew service's database — would corrupt real data, and a shell that already exports
 * DATABASE_URL makes that a one-command mistake. Set MOCK_SEED_ALLOW_ANY_DATABASE=1 to
 * deliberately target something else.
 */
export function mockDatabasePath(): string {
  const url = process.env.DATABASE_URL || DEFAULT_MOCK_DATABASE_URL;
  if (!/^file:/i.test(url)) {
    throw new Error(
      `Mock seeding only supports SQLite file: URLs, received "${url}".`,
    );
  }

  const file = url.replace(/^file:/i, "");
  if (
    path.basename(file) !== MOCK_DATABASE_FILENAME &&
    process.env.MOCK_SEED_ALLOW_ANY_DATABASE !== "1"
  ) {
    throw new Error(
      `Refusing to seed mock data into "${file}": expected a file named ` +
        `${MOCK_DATABASE_FILENAME}. DATABASE_URL is set in this environment and would be ` +
        `overwritten with mock records. Run \`npm run mock:seed\` (which targets ` +
        `${DEFAULT_MOCK_DATABASE_URL}), or set MOCK_SEED_ALLOW_ANY_DATABASE=1 to override.`,
    );
  }

  return file;
}

export function createMockPrismaClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: mockDatabasePath() });
  return new PrismaClient({ adapter });
}
