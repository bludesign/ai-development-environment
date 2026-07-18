CREATE TABLE "Skill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "syncGlobally" BOOLEAN NOT NULL DEFAULT true,
    "packageHash" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "SkillFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "contents" BLOB NOT NULL,
    "executable" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SkillFile_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SkillGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "SkillGroupSkill" (
    "groupId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    PRIMARY KEY ("groupId", "skillId"),
    CONSTRAINT "SkillGroupSkill_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SkillGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillGroupSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CodebaseRepositorySkillGroup" (
    "repositoryId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    PRIMARY KEY ("repositoryId", "groupId"),
    CONSTRAINT "CodebaseRepositorySkillGroup_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CodebaseRepositorySkillGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SkillGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SkillSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "autoSyncProjectGroups" BOOLEAN NOT NULL DEFAULT false,
    "cursorEnabled" BOOLEAN NOT NULL DEFAULT true,
    "githubCopilotEnabled" BOOLEAN NOT NULL DEFAULT true,
    "codexEnabled" BOOLEAN NOT NULL DEFAULT true,
    "claudeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "openCodeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "SkillToolObservation" (
    "agentId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "configured" BOOLEAN NOT NULL DEFAULT false,
    "homePath" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL,
    PRIMARY KEY ("agentId", "tool"),
    CONSTRAINT "SkillToolObservation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SkillInstallation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT,
    "agentId" TEXT NOT NULL,
    "codebaseId" TEXT,
    "worktreeId" TEXT,
    "scope" TEXT NOT NULL,
    "rootKind" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "packageHash" TEXT NOT NULL,
    "present" BOOLEAN NOT NULL DEFAULT true,
    "fileCount" INTEGER NOT NULL,
    "totalBytes" INTEGER NOT NULL,
    "tracked" BOOLEAN NOT NULL DEFAULT false,
    "consumersJson" TEXT NOT NULL DEFAULT '[]',
    "lastSeenAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SkillInstallation_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SkillInstallation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillInstallation_codebaseId_fkey" FOREIGN KEY ("codebaseId") REFERENCES "Codebase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillInstallation_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SkillSyncBaseline" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installationId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "packageHash" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillSyncBaseline_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "SkillInstallation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillSyncBaseline_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SkillDeployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "codebaseId" TEXT,
    "worktreeId" TEXT,
    "scope" TEXT NOT NULL,
    "rootKind" TEXT NOT NULL,
    "targetPath" TEXT NOT NULL,
    "desiredHash" TEXT NOT NULL,
    "installedHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SkillDeployment_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillDeployment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillDeployment_codebaseId_fkey" FOREIGN KEY ("codebaseId") REFERENCES "Codebase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillDeployment_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SkillSyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "groupId" TEXT,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "SkillSyncRun_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SkillGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "SkillSyncItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "skillId" TEXT,
    "installationId" TEXT,
    "agentId" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceHash" TEXT,
    "targetHash" TEXT,
    "resolution" TEXT,
    "candidatePackageJson" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SkillSyncItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SkillSyncRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillSyncItem_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SkillSyncItem_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "SkillInstallation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SkillSyncItem_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Skill_name_key" ON "Skill"("name");
CREATE INDEX "Skill_name_idx" ON "Skill"("name");
CREATE INDEX "Skill_deletedAt_updatedAt_idx" ON "Skill"("deletedAt", "updatedAt");
CREATE UNIQUE INDEX "SkillFile_skillId_path_key" ON "SkillFile"("skillId", "path");
CREATE INDEX "SkillFile_skillId_idx" ON "SkillFile"("skillId");
CREATE UNIQUE INDEX "SkillGroup_name_key" ON "SkillGroup"("name");
CREATE INDEX "SkillGroup_name_idx" ON "SkillGroup"("name");
CREATE INDEX "SkillGroupSkill_skillId_idx" ON "SkillGroupSkill"("skillId");
CREATE INDEX "CodebaseRepositorySkillGroup_groupId_idx" ON "CodebaseRepositorySkillGroup"("groupId");
CREATE INDEX "SkillToolObservation_tool_configured_idx" ON "SkillToolObservation"("tool", "configured");
CREATE UNIQUE INDEX "SkillInstallation_agentId_rootPath_skillName_key" ON "SkillInstallation"("agentId", "rootPath", "skillName");
CREATE INDEX "SkillInstallation_skillName_packageHash_idx" ON "SkillInstallation"("skillName", "packageHash");
CREATE INDEX "SkillInstallation_agentId_lastSeenAt_idx" ON "SkillInstallation"("agentId", "lastSeenAt");
CREATE INDEX "SkillInstallation_codebaseId_idx" ON "SkillInstallation"("codebaseId");
CREATE INDEX "SkillInstallation_worktreeId_idx" ON "SkillInstallation"("worktreeId");
CREATE UNIQUE INDEX "SkillSyncBaseline_installationId_key" ON "SkillSyncBaseline"("installationId");
CREATE INDEX "SkillSyncBaseline_skillId_idx" ON "SkillSyncBaseline"("skillId");
CREATE UNIQUE INDEX "SkillDeployment_agentId_targetPath_key" ON "SkillDeployment"("agentId", "targetPath");
CREATE INDEX "SkillDeployment_skillId_status_idx" ON "SkillDeployment"("skillId", "status");
CREATE INDEX "SkillDeployment_codebaseId_idx" ON "SkillDeployment"("codebaseId");
CREATE INDEX "SkillDeployment_worktreeId_idx" ON "SkillDeployment"("worktreeId");
CREATE INDEX "SkillSyncRun_status_createdAt_idx" ON "SkillSyncRun"("status", "createdAt");
CREATE INDEX "SkillSyncRun_groupId_createdAt_idx" ON "SkillSyncRun"("groupId", "createdAt");
CREATE INDEX "SkillSyncItem_runId_status_idx" ON "SkillSyncItem"("runId", "status");
CREATE INDEX "SkillSyncItem_skillId_idx" ON "SkillSyncItem"("skillId");
CREATE INDEX "SkillSyncItem_agentId_idx" ON "SkillSyncItem"("agentId");
