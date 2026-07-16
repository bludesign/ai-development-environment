-- CreateTable
CREATE TABLE "CodebaseSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "refreshIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- Seed the singleton so routine agent reads never need to write.
INSERT INTO "CodebaseSettings" (
    "id",
    "refreshIntervalSeconds",
    "createdAt",
    "updatedAt"
) VALUES (
    'default',
    30,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
