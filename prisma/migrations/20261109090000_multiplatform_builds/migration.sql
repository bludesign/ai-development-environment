ALTER TABLE "BuildConfiguration"
ADD COLUMN "platformConfigurationsJson" TEXT NOT NULL DEFAULT '[]';

ALTER TABLE "Build" ADD COLUMN "queuePayloadJson" TEXT;

CREATE TABLE "BuildBatchRequestReceipt" (
    "requestKey" TEXT NOT NULL PRIMARY KEY,
    "payloadDigest" TEXT NOT NULL
);
