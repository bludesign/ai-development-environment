DROP INDEX "BuildLogChunk_buildId_createdAt_id_idx";

CREATE INDEX "BuildLogChunk_buildId_createdAt_sequence_id_idx" ON "BuildLogChunk"("buildId", "createdAt", "sequence", "id");
