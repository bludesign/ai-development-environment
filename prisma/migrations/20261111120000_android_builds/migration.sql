CREATE TABLE "AndroidBuildConfiguration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "projectPath" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "apkPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AndroidBuildConfiguration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodebaseProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AndroidBuildConfiguration_projectId_name_key" ON "AndroidBuildConfiguration"("projectId", "name");
ALTER TABLE "Build" ADD COLUMN "androidConfigurationId" TEXT REFERENCES "AndroidBuildConfiguration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Build_androidConfigurationId_createdAt_idx" ON "Build"("androidConfigurationId", "createdAt");
