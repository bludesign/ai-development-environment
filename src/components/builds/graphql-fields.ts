export const BUILD_PLATFORM_CONFIGURATION_FIELDS = `
  platform sourceKind sourcePath scheme buildConfiguration defaultAction advancedSettings autoExport exportSettings
`;

export const BUILD_LIST_FIELDS = `
  id requestId jobId status action platform destinationType destination snapshot commandSummary artifactDirectory errorCode error warnings outOfDate
  createdAt startedAt finishedAt durationMs updatedAt
  worktree { id highlightColor }
  configuration { id name }
  artifacts { id kind relativePath sizeBytes checksum metadata createdAt }
`;
