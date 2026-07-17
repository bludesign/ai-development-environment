export type Agent = {
  id: string;
  name: string;
  hostname: string;
  version: string;
  osVersion: string;
  architecture: string;
  cpuModel?: string | null;
  memoryTotalBytes?: number | null;
  memoryFreeBytes?: number | null;
  diskTotalBytes?: number | null;
  diskFreeBytes?: number | null;
  capabilities: string[];
  baseRepoDirectory: string | null;
  connectionStatus: "ONLINE" | "OFFLINE";
  ipAddress: string | null;
  lastSeenAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
};

export type AgentJob = {
  id: string;
  agentId: string;
  kind: string;
  payload: Record<string, unknown>;
  status:
    "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  error: string | null;
  result: unknown;
  timeoutSeconds: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type AgentJobLog = {
  id: string;
  jobId: string;
  sequence: number;
  stream: "STDOUT" | "STDERR" | "SYSTEM";
  message: string;
  createdAt: string;
};
