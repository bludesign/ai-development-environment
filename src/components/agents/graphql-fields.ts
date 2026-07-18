export const AGENT_FIELDS = `id name hostname version osVersion architecture cpuModel memoryTotalBytes memoryFreeBytes diskTotalBytes diskFreeBytes capabilities baseRepoDirectory derivedDataLocationMode derivedDataPath buildsDirectory defaultBuildsDirectory effectiveBuildsDirectory connectionStatus ipAddress lastSeenAt disconnectedAt createdAt`;
export const JOB_FIELDS = `id agentId kind payload status error result timeoutSeconds createdAt startedAt finishedAt updatedAt`;
export const JOB_LOG_FIELDS = `id jobId sequence stream message createdAt`;
