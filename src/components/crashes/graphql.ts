export const CRASH_FRAME_FIELDS = `
  index imageName imageUuid address imageOffset symbol symbolOffset
  sourceFile sourceLine inlined isAppFrame symbolicated
`;

export const CRASH_SUMMARY_FIELDS = `
  id format source status statusMessage filename appName bundleId appVersion
  buildVersion osVersion deviceModel exceptionType signal signatureTitle
  crashedAt createdAt topAppFrame { ${CRASH_FRAME_FIELDS} }
`;

export const DSYM_UPLOAD_FIELDS = `
  id filename status error source uploadedBy buildId linkedBuildId url
  projectName sizeBytes uploadOffset attempts dsymCount createdAt updatedAt
  completedAt
`;

export const DSYM_SUMMARY_FIELDS = `
  id bundleName binaryName bundleIdentifier shortVersion bundleVersion
  dwarfSizeBytes createdAt crashCount
  slices { id uuid arch textVmAddr }
  upload { ${DSYM_UPLOAD_FIELDS} }
`;

export const CRASHES_QUERY = `query CrashesPage($filter: CrashReportFilter, $first: Int, $after: String) {
  crashReports(filter: $filter, first: $first, after: $after) {
    nodes { ${CRASH_SUMMARY_FIELDS} }
    nextCursor totalCount matchingCount
  }
  crashFacets { apps { bundleId appName count } appVersions }
}`;

export const DSYMS_QUERY = `query DsymsPage($filter: DsymFilter, $first: Int, $after: String) {
  dsyms(filter: $filter, first: $first, after: $after) {
    nodes { ${DSYM_SUMMARY_FIELDS} }
    nextCursor totalCount matchingCount
  }
  dsymProjects
  dsymUploads { ${DSYM_UPLOAD_FIELDS} }
}`;

export const CRASH_DETAIL_QUERY = `query CrashDetail($id: ID!) {
  crashReport(id: $id) {
    ${CRASH_SUMMARY_FIELDS}
    sizeBytes incidentId arch exceptionCodes exceptionSubtype exceptionReason
    terminationReason applicationSpecificInformation crashedThread updatedAt
    symbolicatedAt signature uploadedBy apiKeyName clientIp attempts
    threads { index name queue crashed frames { ${CRASH_FRAME_FIELDS} } }
    lastExceptionBacktrace { ${CRASH_FRAME_FIELDS} }
    binaryImages {
      id uuid name arch loadAddress path isApp frameCount
      dsym { id bundleName }
    }
    missingImages {
      id uuid name arch loadAddress path isApp frameCount
      dsym { id bundleName }
    }
    attachedDsyms { ${DSYM_SUMMARY_FIELDS} }
    similarCrashCount
    similarCrashes(first: 20) { ${CRASH_SUMMARY_FIELDS} }
    symbolicatedText originalDownloadUrl symbolicatedDownloadUrl
  }
}`;

export const DSYM_DETAIL_QUERY = `query DsymDetail($id: ID!, $after: String) {
  dsym(id: $id) {
    ${DSYM_SUMMARY_FIELDS}
    dwarfSha256 downloadUrl
    siblingDsyms { ${DSYM_SUMMARY_FIELDS} }
    crashes(first: 50, after: $after) {
      nodes { ${CRASH_SUMMARY_FIELDS} }
      nextCursor totalCount
    }
  }
}`;

export const CRASH_SETTINGS_QUERY = `query CrashSettings {
  crashSettings {
    collectionEnabled symbolicationAgentId retentionDays dsymRetentionDays
  }
  crashSymbolicationAgents { id name hostname online }
}`;

export const UPDATE_CRASH_SETTINGS_MUTATION = `mutation UpdateCrashSettings($input: CrashSettingsInput!) {
  updateCrashSettings(input: $input) {
    collectionEnabled symbolicationAgentId retentionDays dsymRetentionDays
  }
}`;

export const SYMBOLICATE_CRASH_MUTATION = `mutation SymbolicateCrashReport($id: ID!) {
  symbolicateCrashReport(id: $id) { id status }
}`;

export const DELETE_CRASHES_MUTATION = `mutation DeleteCrashReports($ids: [ID!]!) {
  deleteCrashReports(ids: $ids)
}`;

export const DELETE_DSYMS_MUTATION = `mutation DeleteDsyms($ids: [ID!]!) {
  deleteDsyms(ids: $ids)
}`;

export const DELETE_DSYM_UPLOAD_MUTATION = `mutation DeleteDsymUpload($id: ID!) {
  deleteDsymUpload(id: $id)
}`;

export const RETRY_DSYM_UPLOAD_MUTATION = `mutation RetryDsymUpload($id: ID!) {
  retryDsymUpload(id: $id) { id status }
}`;

export const UPDATE_DSYM_UPLOAD_MUTATION = `mutation UpdateDsymUpload($id: ID!, $input: DsymUploadMetadataInput!) {
  updateDsymUpload(id: $id, input: $input) { ${DSYM_UPLOAD_FIELDS} }
}`;
