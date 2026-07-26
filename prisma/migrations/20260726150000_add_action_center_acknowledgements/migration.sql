CREATE TABLE "ActionCenterAcknowledgement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "failureFingerprint" TEXT NOT NULL,
    "acknowledgedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ActionCenterAcknowledgement_resourceKind_resourceId_failureFingerprint_key"
ON "ActionCenterAcknowledgement"("resourceKind", "resourceId", "failureFingerprint");

CREATE INDEX "ActionCenterAcknowledgement_acknowledgedAt_idx"
ON "ActionCenterAcknowledgement"("acknowledgedAt");
