export const AGENT_FIELDS = `id name hostname version osVersion architecture capabilities baseRepoDirectory connectionStatus ipAddress lastSeenAt disconnectedAt createdAt`;
export const JOB_FIELDS = `id agentId kind payload status error result timeoutSeconds createdAt startedAt finishedAt updatedAt`;
export const JOB_LOG_FIELDS = `id jobId sequence stream message createdAt`;
