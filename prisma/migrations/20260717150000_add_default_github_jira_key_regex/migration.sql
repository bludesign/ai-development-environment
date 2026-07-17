ALTER TABLE "GitHubSettings"
ADD COLUMN "defaultJiraKeyRegex" TEXT NOT NULL DEFAULT '\b([A-Z][A-Z0-9_]*-\d+)\b';

UPDATE "GitHubRepository"
SET "jiraKeyRegex" = NULL
WHERE "jiraKeyRegex" = '\b([A-Z][A-Z0-9_]*-\d+)\b';
