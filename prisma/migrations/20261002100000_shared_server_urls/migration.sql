CREATE TABLE "ServerUrlSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "localBaseUrlOverride" TEXT,
  "remoteBaseUrlOverride" TEXT,
  "proxyBaseUrl" TEXT,
  "defaultServerUrlKind" TEXT NOT NULL DEFAULT 'LOCAL',
  "simulatorDefaultServerUrlKind" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
INSERT INTO "ServerUrlSettings" ("id", "localBaseUrlOverride", "remoteBaseUrlOverride", "createdAt", "updatedAt")
SELECT "id", "localBaseUrlOverride", "remoteBaseUrlOverride", "createdAt", "updatedAt" FROM "TelemetrySettings";
