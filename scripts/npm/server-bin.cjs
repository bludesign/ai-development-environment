#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageRoot = path.join(__dirname, "..");

process.env.HOSTNAME ||= "127.0.0.1";
process.env.PORT ||= "3090";
process.env.AGENT_WS_HOSTNAME ||= "127.0.0.1";
process.env.AGENT_WS_PORT ||= "3091";
process.env.DATABASE_URL ||= `file:${path.join(
  os.homedir(),
  ".ai-development-environment",
  "production.db",
)}`;

// Prisma's SQLite migration engine expects the database file to exist before the first
// `migrate deploy`. Create it without truncating an existing database.
if (process.env.DATABASE_URL.startsWith("file:")) {
  const databasePath = process.env.DATABASE_URL.slice("file:".length);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (!fs.existsSync(databasePath)) {
    fs.closeSync(fs.openSync(databasePath, "a"));
  }
}

// Apply any pending database migrations before starting the server. Fail fast rather than
// serve against a database whose migrations could not be applied.
const prismaCli = require.resolve("prisma/build/index.js");
const migrate = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
  cwd: path.join(packageRoot, "prisma-runtime"),
  stdio: "inherit",
});
if (migrate.status !== 0) {
  console.error(
    "ai-development-environment: database migration failed; not starting server",
  );
  process.exit(migrate.status ?? 1);
}

require(path.join(packageRoot, "standalone", "server.js"));
