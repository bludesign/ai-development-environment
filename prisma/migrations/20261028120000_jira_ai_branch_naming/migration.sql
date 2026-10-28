ALTER TABLE "JiraProject" ADD COLUMN "branchNamingMode" TEXT NOT NULL DEFAULT 'JAVASCRIPT';
ALTER TABLE "JiraProject" ADD COLUMN "branchNamingProvider" TEXT;
ALTER TABLE "JiraProject" ADD COLUMN "branchNamingModel" TEXT;
ALTER TABLE "JiraProject" ADD COLUMN "branchNamingEffort" TEXT;
ALTER TABLE "JiraProject" ADD COLUMN "branchNamingPrompt" TEXT;
