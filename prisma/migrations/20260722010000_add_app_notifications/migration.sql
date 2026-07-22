CREATE TABLE "AppNotification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "dedupeKey" TEXT NOT NULL,
  "typeKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "href" TEXT NOT NULL,
  "resourceKind" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "worktreeId" TEXT,
  "highlightColor" TEXT,
  "sidebarRequested" BOOLEAN NOT NULL,
  "browserRequested" BOOLEAN NOT NULL,
  "webPushRequested" BOOLEAN NOT NULL,
  "sidebarDismissedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "AppNotification_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AppNotification_dedupeKey_key" ON "AppNotification"("dedupeKey");
CREATE INDEX "AppNotification_createdAt_idx" ON "AppNotification"("createdAt");
CREATE INDEX "AppNotification_typeKey_createdAt_idx" ON "AppNotification"("typeKey", "createdAt");
CREATE INDEX "AppNotification_worktreeId_idx" ON "AppNotification"("worktreeId");
CREATE INDEX "AppNotification_sidebarRequested_sidebarDismissedAt_createdAt_idx" ON "AppNotification"("sidebarRequested", "sidebarDismissedAt", "createdAt");

CREATE TABLE "NotificationPreference" (
  "typeKey" TEXT NOT NULL PRIMARY KEY,
  "sidebarEnabled" BOOLEAN NOT NULL,
  "browserEnabled" BOOLEAN NOT NULL,
  "webPushEnabled" BOOLEAN NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "WebPushSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vapidPublicKey" TEXT,
  "vapidGeneratedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "WebPushSubscription" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "expirationTime" DATETIME,
  "locale" TEXT,
  "userAgent" TEXT,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "WebPushSubscription_endpoint_key" ON "WebPushSubscription"("endpoint");
CREATE INDEX "WebPushSubscription_lastSeenAt_idx" ON "WebPushSubscription"("lastSeenAt");
