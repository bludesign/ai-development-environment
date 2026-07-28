-- AlterTable
ALTER TABLE "JiraSettings" ADD COLUMN "webhookId" TEXT;

-- AlterTable
ALTER TABLE "JiraSettings" ADD COLUMN "webhookUrl" TEXT;

-- AlterTable
ALTER TABLE "JiraSettings" ADD COLUMN "webhookJql" TEXT;
