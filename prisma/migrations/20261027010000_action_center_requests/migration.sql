CREATE TABLE "ActionCenterSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "maximumRequestAgeDays" INTEGER NOT NULL DEFAULT 30,
  "showMyRequestsInSidebar" BOOLEAN NOT NULL DEFAULT true,
  "showReviewRequestsInSidebar" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "ActionCenterRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "accountKey" TEXT NOT NULL,
  "resourceKind" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "isMine" BOOLEAN NOT NULL,
  "requiresMyApproval" BOOLEAN NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "ActionCenterRequest_provider_accountKey_idx" ON "ActionCenterRequest"("provider", "accountKey");
CREATE INDEX "ActionCenterRequest_reason_updatedAt_id_idx" ON "ActionCenterRequest"("reason", "updatedAt", "id");
CREATE INDEX "ActionCenterRequest_createdAt_idx" ON "ActionCenterRequest"("createdAt");
