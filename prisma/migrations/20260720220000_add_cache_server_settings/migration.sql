-- CreateTable
CREATE TABLE "CacheServerSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "baseUrl" TEXT,
    "apiKey" TEXT,
    "headersJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
