-- AlterTable
ALTER TABLE "JiraProject" ADD COLUMN "ticketAssignmentFilter" TEXT NOT NULL DEFAULT 'ALL';
ALTER TABLE "JiraProject" ADD COLUMN "hideCompletedTickets" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JiraProject" ADD COLUMN "completedStatusIdsJson" TEXT NOT NULL DEFAULT '[]';
