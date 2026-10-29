ALTER TABLE "CodebaseRepository" ADD COLUMN "hasConfiguredCodeReviewers" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "RepositoryReviewerPool" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "repositoryId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "repositoryIdentity" TEXT NOT NULL,
  "discoveryRef" TEXT NOT NULL DEFAULT '',
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RepositoryReviewerPool_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RepositoryReviewerPool_repositoryId_key_key" ON "RepositoryReviewerPool"("repositoryId", "key");

CREATE TABLE "RepositoryReviewerMember" (
  "poolId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "avatarUrl" TEXT,
  "url" TEXT,
  PRIMARY KEY ("poolId", "userId"),
  CONSTRAINT "RepositoryReviewerMember_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "RepositoryReviewerPool" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
