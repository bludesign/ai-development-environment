#!/usr/bin/env node

import { statSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";

const databaseUrl = process.env.DATABASE_URL || "file:./prisma/dev.db";
if (!/^file:/i.test(databaseUrl)) {
  throw new Error("db:vacuum supports SQLite file: database URLs only");
}

const databasePath = resolve(process.cwd(), databaseUrl.replace(/^file:/i, ""));
const megabytes = (bytes) => (bytes / 1024 / 1024).toFixed(1);
const beforeBytes = statSync(databasePath).size;
const database = new Database(databasePath, {
  fileMustExist: true,
  timeout: 5_000,
});

try {
  const checkpoint = database.pragma("wal_checkpoint(TRUNCATE)")[0];
  if (Number(checkpoint?.busy ?? 0) !== 0) {
    throw new Error(
      "SQLite is busy. Stop the application and other database clients before vacuuming.",
    );
  }
  database.exec("VACUUM");
  database.pragma("wal_checkpoint(TRUNCATE)");
} finally {
  database.close();
}

const afterBytes = statSync(databasePath).size;
console.log(
  `Vacuumed ${databasePath}: ${megabytes(beforeBytes)} MB -> ${megabytes(afterBytes)} MB`,
);
