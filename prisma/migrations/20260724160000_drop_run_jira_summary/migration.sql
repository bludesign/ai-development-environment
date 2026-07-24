-- Runs retain the Jira issue key and resolve current ticket metadata on demand.
ALTER TABLE "AgentRun" DROP COLUMN "jiraSummary";
ALTER TABLE "RunDraft" DROP COLUMN "jiraSummary";
