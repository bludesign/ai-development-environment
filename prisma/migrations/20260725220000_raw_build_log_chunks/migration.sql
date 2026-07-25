DROP TABLE "BuildLogEvent";

CREATE TABLE "BuildLogChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buildId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "dataBase64" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuildLogChunk_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BuildLogChunk_buildId_createdAt_id_idx" ON "BuildLogChunk"("buildId", "createdAt", "id");
CREATE UNIQUE INDEX "BuildLogChunk_scope_scopeId_sequence_key" ON "BuildLogChunk"("scope", "scopeId", "sequence");
