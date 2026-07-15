import "server-only";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "@/generated/prisma/client";

const DEFAULT_DATABASE_URL = "file:./prisma/dev.db";

const globalForPrisma = globalThis as typeof globalThis & {
  prismaGlobal?: PrismaClient;
};

let prismaClient = globalForPrisma.prismaGlobal;
let initializationPromise: Promise<PrismaClient> | null = null;

export function sqlitePathFromDatabaseUrl(url: string): string {
  if (/^file:/i.test(url)) return url.replace(/^file:/i, "");

  const schemeSeparator = url.indexOf(":");
  const scheme =
    schemeSeparator === -1 ? "missing" : url.slice(0, schemeSeparator);
  throw new Error(
    `Unsupported DATABASE_URL scheme "${scheme}". This build supports SQLite file: URLs only.`,
  );
}

async function createPrismaClient(): Promise<PrismaClient> {
  const url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  const adapter = new PrismaBetterSqlite3({
    url: sqlitePathFromDatabaseUrl(url),
  });
  const client = new PrismaClient({ adapter });

  // Apply connection-level SQLite settings only when the application first performs a
  // database operation. Keeping this out of module evaluation prevents `next build` from
  // creating or mutating the configured runtime database.
  try {
    await client.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
    await client.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
  } catch (error: unknown) {
    console.error("Failed to apply SQLite WAL pragmas:", error);
  }

  return client;
}

export async function getPrismaClient(): Promise<PrismaClient> {
  if (prismaClient) return prismaClient;

  if (!initializationPromise) {
    initializationPromise = createPrismaClient()
      .then((client) => {
        prismaClient = client;
        if (process.env.NODE_ENV !== "production") {
          globalForPrisma.prismaGlobal = client;
        }
        return client;
      })
      .finally(() => {
        initializationPromise = null;
      });
  }

  return initializationPromise;
}
