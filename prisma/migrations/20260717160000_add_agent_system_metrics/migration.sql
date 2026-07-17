ALTER TABLE "Agent" ADD COLUMN "cpuModel" TEXT;
ALTER TABLE "Agent" ADD COLUMN "memoryTotalBytes" REAL;
ALTER TABLE "Agent" ADD COLUMN "memoryFreeBytes" REAL;
ALTER TABLE "Agent" ADD COLUMN "diskTotalBytes" REAL;
ALTER TABLE "Agent" ADD COLUMN "diskFreeBytes" REAL;
