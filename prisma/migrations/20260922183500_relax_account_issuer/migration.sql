-- Better Auth 1.7.3+ identifies accounts by providerId/accountId and no longer
-- writes issuer. Preserve existing issuer values, but allow new accounts to
-- omit it and remove the obsolete issuer/accountId unique constraint.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuer" TEXT,
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
    "id", "issuer", "accountId", "providerId", "userId", "accessToken",
    "refreshToken", "idToken", "accessTokenExpiresAt",
    "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt"
FROM "account";

DROP TABLE "account";
ALTER TABLE "new_account" RENAME TO "account";

CREATE INDEX "account_userId_idx" ON "account"("userId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
