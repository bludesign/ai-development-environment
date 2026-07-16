CREATE TABLE "ExternalMcpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "toolNamePrefix" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ExternalMcpServerHeader" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExternalMcpServerHeader_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "ExternalMcpServer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ExternalMcpServer_name_key" ON "ExternalMcpServer"("name");
CREATE INDEX "ExternalMcpServer_name_idx" ON "ExternalMcpServer"("name");
CREATE UNIQUE INDEX "ExternalMcpServerHeader_serverId_name_key" ON "ExternalMcpServerHeader"("serverId", "name");
CREATE INDEX "ExternalMcpServerHeader_serverId_idx" ON "ExternalMcpServerHeader"("serverId");
