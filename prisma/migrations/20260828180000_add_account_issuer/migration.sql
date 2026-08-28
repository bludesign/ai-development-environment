-- Better Auth 1.7 scopes provider identities by issuer and account ID. Preserve
-- the previous providerId/accountId identity for existing OAuth accounts with a
-- stable local namespace; credential accounts use Better Auth's fixed issuer.
-- SQLite requires a table rebuild to make the backfilled column NOT NULL.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuer" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" DATETIME,
    "refreshTokenExpiresAt" DATETIME,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_account" (
    "id", "issuer", "accountId", "providerId", "userId", "accessToken",
    "refreshToken", "idToken", "accessTokenExpiresAt",
    "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt"
)
SELECT
    "id",
    CASE
        WHEN "providerId" = 'credential' THEN 'local:credential'
        ELSE 'local:oauth:' || "providerId"
    END,
    "accountId", "providerId", "userId", "accessToken", "refreshToken",
    "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope",
    "password", "createdAt", "updatedAt"
FROM "account";

DROP TABLE "account";
ALTER TABLE "new_account" RENAME TO "account";

CREATE INDEX "account_userId_idx" ON "account"("userId");
CREATE UNIQUE INDEX "account_issuer_accountId_key" ON "account"("issuer", "accountId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
