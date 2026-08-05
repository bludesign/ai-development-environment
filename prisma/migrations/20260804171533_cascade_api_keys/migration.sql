-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_apikey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "start" TEXT,
    "referenceId" TEXT NOT NULL,
    "prefix" TEXT,
    "key" TEXT NOT NULL,
    "refillInterval" INTEGER,
    "refillAmount" INTEGER,
    "lastRefillAt" DATETIME,
    "enabled" BOOLEAN DEFAULT true,
    "rateLimitEnabled" BOOLEAN DEFAULT false,
    "rateLimitTimeWindow" INTEGER,
    "rateLimitMax" INTEGER,
    "requestCount" INTEGER DEFAULT 0,
    "remaining" INTEGER,
    "lastRequest" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "permissions" TEXT,
    "metadata" TEXT,
    CONSTRAINT "apikey_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_apikey" ("configId", "createdAt", "enabled", "expiresAt", "id", "key", "lastRefillAt", "lastRequest", "metadata", "name", "permissions", "prefix", "rateLimitEnabled", "rateLimitMax", "rateLimitTimeWindow", "referenceId", "refillAmount", "refillInterval", "remaining", "requestCount", "start", "updatedAt") SELECT "configId", "createdAt", "enabled", "expiresAt", "id", "key", "lastRefillAt", "lastRequest", "metadata", "name", "permissions", "prefix", "rateLimitEnabled", "rateLimitMax", "rateLimitTimeWindow", "referenceId", "refillAmount", "refillInterval", "remaining", "requestCount", "start", "updatedAt" FROM "apikey";
DROP TABLE "apikey";
ALTER TABLE "new_apikey" RENAME TO "apikey";
CREATE INDEX "apikey_configId_idx" ON "apikey"("configId");
CREATE INDEX "apikey_referenceId_idx" ON "apikey"("referenceId");
CREATE INDEX "apikey_key_idx" ON "apikey"("key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
