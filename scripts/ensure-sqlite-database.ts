import "dotenv/config";

import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function ensureSqliteDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  if (!databaseUrl.toLowerCase().startsWith("file:")) {
    throw new Error(
      "Development database preparation requires a SQLite file: URL",
    );
  }

  const configuredPath = databaseUrl.replace(/^file:/i, "");
  const databasePath = resolve(process.cwd(), configuredPath);
  await mkdir(dirname(databasePath), { recursive: true });
  const database = await open(databasePath, "a", 0o600);
  await database.close();
}

ensureSqliteDatabase().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
