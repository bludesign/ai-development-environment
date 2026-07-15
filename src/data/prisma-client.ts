import "server-only";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import {
  databaseProvider,
  type DatabaseProvider,
} from "@/generated/database-provider";

const DEFAULT_DATABASE_URL = "file:./prisma/dev.db";

const globalForPrisma = globalThis as typeof globalThis & {
  prismaGlobal?: PrismaClient;
};

let prismaClient = globalForPrisma.prismaGlobal;
let initializationPromise: Promise<PrismaClient> | null = null;

export function databaseProviderFromUrl(url: string): DatabaseProvider {
  if (/^file:/i.test(url)) return "sqlite";
  if (/^postgres(ql)?:\/\//i.test(url)) return "postgresql";

  const schemeSeparator = url.indexOf(":");
  const scheme =
    schemeSeparator === -1 ? "missing" : url.slice(0, schemeSeparator);
  throw new Error(
    `Unsupported DATABASE_URL scheme "${scheme}". Expected file:, postgres:, or postgresql:.`,
  );
}

export function assertDatabaseProviderMatchesUrl(
  url: string,
  generatedProvider: DatabaseProvider = databaseProvider,
): DatabaseProvider {
  const urlProvider = databaseProviderFromUrl(url);

  if (urlProvider !== generatedProvider) {
    throw new Error(
      `DATABASE_URL requires the ${urlProvider} provider, but this Prisma client was generated for ${generatedProvider}. Change prisma/schema.prisma and rebuild the application before switching database providers.`,
    );
  }

  return urlProvider;
}

async function createPrismaClient(): Promise<PrismaClient> {
  const url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  const provider = assertDatabaseProviderMatchesUrl(url);
  const adapter =
    provider === "postgresql"
      ? new PrismaPg({ connectionString: url })
      : new PrismaBetterSqlite3({ url: url.replace(/^file:/i, "") });
  const client = new PrismaClient({ adapter });

  // Apply connection-level SQLite settings only when the application first performs a
  // database operation. Keeping this out of module evaluation prevents `next build` from
  // creating or mutating the configured runtime database.
  if (provider === "sqlite") {
    try {
      await client.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
      await client.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
    } catch (error: unknown) {
      console.error("Failed to apply SQLite WAL pragmas:", error);
    }
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
