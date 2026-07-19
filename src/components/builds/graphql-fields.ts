export const BUILD_LIST_FIELDS = `
  id requestId jobId status action destinationType destination snapshot commandSummary artifactDirectory errorCode error outOfDate
  createdAt startedAt finishedAt durationMs updatedAt
  artifacts { id kind relativePath sizeBytes checksum metadata createdAt }
`;
