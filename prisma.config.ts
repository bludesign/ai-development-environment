import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma 7 reads the CLI/migration connection URL from here rather than from the schema's
// datasource block (which now only declares the provider). `.env` is no longer auto-loaded
// by Prisma, hence the explicit `dotenv/config` import above. The runtime client resolves
// DATABASE_URL independently in src/data/prisma-client.ts.
export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL || "file:./prisma/dev.db",
  },
});
