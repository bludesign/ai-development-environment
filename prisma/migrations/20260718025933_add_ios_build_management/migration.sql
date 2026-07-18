-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "buildsDirectory" TEXT;
ALTER TABLE "Agent" ADD COLUMN "defaultBuildsDirectory" TEXT;

-- CreateTable
CREATE TABLE "CodebaseProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CodebaseProject_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BuildSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BuildSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodebaseProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BuildSourceObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "codebaseId" TEXT,
    "worktreeId" TEXT,
    "status" TEXT NOT NULL,
    "schemesJson" TEXT NOT NULL DEFAULT '[]',
    "configurationsJson" TEXT NOT NULL DEFAULT '[]',
    "testPlansJson" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "headSha" TEXT,
    "xcodeVersion" TEXT,
    "lastParseAttemptAt" DATETIME NOT NULL,
    "lastParsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BuildSourceObservation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "BuildSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BuildSourceObservation_codebaseId_fkey" FOREIGN KEY ("codebaseId") REFERENCES "Codebase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BuildSourceObservation_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BuildConfiguration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iconKey" TEXT,
    "scheme" TEXT NOT NULL,
    "buildConfiguration" TEXT NOT NULL,
    "defaultAction" TEXT NOT NULL DEFAULT 'BUILD',
    "advancedSettingsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BuildConfiguration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodebaseProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BuildConfiguration_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "BuildSource" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BuildScript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "preBuildScript" TEXT,
    "postBuildScript" TEXT,
    "enabledByDefault" BOOLEAN NOT NULL DEFAULT false,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 300,
    "failureBehavior" TEXT NOT NULL DEFAULT 'FAIL_BUILD',
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CodebaseRepositoryBuildScript" (
    "repositoryId" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("repositoryId", "scriptId"),
    CONSTRAINT "CodebaseRepositoryBuildScript_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CodebaseRepositoryBuildScript_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "BuildScript" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Build" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestKey" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "agentId" TEXT,
    "codebaseId" TEXT,
    "worktreeId" TEXT,
    "configurationId" TEXT,
    "jobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "action" TEXT NOT NULL,
    "destinationType" TEXT NOT NULL,
    "destinationJson" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "commandSummary" TEXT NOT NULL,
    "artifactDirectory" TEXT NOT NULL,
    "errorCode" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Build_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Build_codebaseId_fkey" FOREIGN KEY ("codebaseId") REFERENCES "Codebase" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Build_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Build_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "BuildConfiguration" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Build_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AgentJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BuildArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buildId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "sizeBytes" REAL,
    "checksum" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuildArtifact_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BuildScriptExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buildId" TEXT NOT NULL,
    "scriptId" TEXT,
    "phase" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "sourceSnapshot" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL,
    "failureBehavior" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "exitCode" INTEGER,
    "durationMs" INTEGER,
    "causedBuildFailure" BOOLEAN NOT NULL DEFAULT false,
    "outputRelativePath" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BuildScriptExecution_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BuildScriptExecution_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "BuildScript" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BuildLogEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buildId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuildLogEvent_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BuildDeployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buildId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "jobId" TEXT,
    "destinationJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "commandSummary" TEXT NOT NULL,
    "outputRelativePath" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BuildDeployment_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BuildDeployment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AgentJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BuildExport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buildId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "jobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "settingsSnapshotJson" TEXT NOT NULL,
    "commandSummary" TEXT NOT NULL,
    "outputRelativePath" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BuildExport_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BuildExport_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AgentJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CodebaseProject_repositoryId_idx" ON "CodebaseProject"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "CodebaseProject_repositoryId_type_key" ON "CodebaseProject"("repositoryId", "type");

-- CreateIndex
CREATE INDEX "BuildSource_projectId_idx" ON "BuildSource"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "BuildSource_projectId_relativePath_key" ON "BuildSource"("projectId", "relativePath");

-- CreateIndex
CREATE INDEX "BuildSourceObservation_codebaseId_idx" ON "BuildSourceObservation"("codebaseId");

-- CreateIndex
CREATE INDEX "BuildSourceObservation_worktreeId_idx" ON "BuildSourceObservation"("worktreeId");

-- CreateIndex
CREATE UNIQUE INDEX "BuildSourceObservation_sourceId_scopeKey_key" ON "BuildSourceObservation"("sourceId", "scopeKey");

-- CreateIndex
CREATE INDEX "BuildConfiguration_projectId_idx" ON "BuildConfiguration"("projectId");

-- CreateIndex
CREATE INDEX "BuildConfiguration_sourceId_idx" ON "BuildConfiguration"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "BuildConfiguration_projectId_name_key" ON "BuildConfiguration"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BuildScript_name_key" ON "BuildScript"("name");

-- CreateIndex
CREATE INDEX "BuildScript_deletedAt_name_idx" ON "BuildScript"("deletedAt", "name");

-- CreateIndex
CREATE INDEX "CodebaseRepositoryBuildScript_scriptId_idx" ON "CodebaseRepositoryBuildScript"("scriptId");

-- CreateIndex
CREATE UNIQUE INDEX "Build_requestKey_key" ON "Build"("requestKey");

-- CreateIndex
CREATE INDEX "Build_status_createdAt_idx" ON "Build"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Build_agentId_createdAt_idx" ON "Build"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "Build_codebaseId_createdAt_idx" ON "Build"("codebaseId", "createdAt");

-- CreateIndex
CREATE INDEX "Build_worktreeId_createdAt_idx" ON "Build"("worktreeId", "createdAt");

-- CreateIndex
CREATE INDEX "Build_jobId_idx" ON "Build"("jobId");

-- CreateIndex
CREATE INDEX "BuildArtifact_buildId_kind_idx" ON "BuildArtifact"("buildId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "BuildArtifact_buildId_relativePath_key" ON "BuildArtifact"("buildId", "relativePath");

-- CreateIndex
CREATE INDEX "BuildScriptExecution_buildId_phase_idx" ON "BuildScriptExecution"("buildId", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "BuildScriptExecution_buildId_phase_position_key" ON "BuildScriptExecution"("buildId", "phase", "position");

-- CreateIndex
CREATE INDEX "BuildLogEvent_buildId_createdAt_idx" ON "BuildLogEvent"("buildId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BuildLogEvent_scope_scopeId_sequence_key" ON "BuildLogEvent"("scope", "scopeId", "sequence");

-- CreateIndex
CREATE INDEX "BuildDeployment_buildId_createdAt_idx" ON "BuildDeployment"("buildId", "createdAt");

-- CreateIndex
CREATE INDEX "BuildDeployment_jobId_idx" ON "BuildDeployment"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "BuildDeployment_buildId_requestId_destinationJson_key" ON "BuildDeployment"("buildId", "requestId", "destinationJson");

-- CreateIndex
CREATE INDEX "BuildExport_buildId_createdAt_idx" ON "BuildExport"("buildId", "createdAt");

-- CreateIndex
CREATE INDEX "BuildExport_jobId_idx" ON "BuildExport"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "BuildExport_buildId_requestId_key" ON "BuildExport"("buildId", "requestId");
