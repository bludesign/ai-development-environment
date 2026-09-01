-- AlterTable
ALTER TABLE "SseMockEventTemplate" ADD COLUMN "retryMsTemplate" TEXT;
ALTER TABLE "SseMockEventTemplate" ADD COLUMN "fieldsJson" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "SseMockBlock" ADD COLUMN "templateValuesJson" TEXT NOT NULL DEFAULT '[]';
