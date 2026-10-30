CREATE TABLE "ReviewerDirectorySnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "responseJson" TEXT NOT NULL,
  "fetchedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ReviewerDirectorySnapshot_key_key" ON "ReviewerDirectorySnapshot"("key");
CREATE INDEX "ReviewerDirectorySnapshot_provider_fetchedAt_idx" ON "ReviewerDirectorySnapshot"("provider", "fetchedAt");
