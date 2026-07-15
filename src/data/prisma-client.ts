import "server-only";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

const DEFAULT_DATABASE_URL = "file:./prisma/dev.db";

const createPrismaClient = () => {
  const url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  const isPostgres = /^postgres(ql)?:\/\//i.test(url);

  // Driver adapter is chosen by URL scheme: SQLite now, Postgres when DATABASE_URL points at
  // a postgres:// server. Both adapters are installed so switching databases is a config +
  // schema-provider change with no code change here.
  const adapter = isPostgres
    ? new PrismaPg({ connectionString: url })
    : new PrismaBetterSqlite3({ url: url.replace(/^file:/, "") });

  const client = new PrismaClient({ adapter });

  // SQLite only: WAL lets reads (e.g. the GraphQL health check) proceed concurrently with
  // writes instead of blocking on exclusive locks — important for the long-running brew
  // service. journal_mode is persisted on the DB file; synchronous is per-connection and so
  // is re-applied on every startup. The better-sqlite3 adapter uses a single long-lived
  // connection, so applying it once here covers the process.
  if (!isPostgres) {
    client
      .$queryRawUnsafe("PRAGMA journal_mode = WAL;")
      .then(() => client.$queryRawUnsafe("PRAGMA synchronous = NORMAL;"))
      .catch((error: unknown) => {
        console.error("Failed to apply SQLite WAL pragmas:", error);
      });
  }

  return client;
};

declare const globalThis: {
  prismaGlobal: ReturnType<typeof createPrismaClient>;
} & typeof global;

export const prisma = globalThis.prismaGlobal ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalThis.prismaGlobal = prisma;
