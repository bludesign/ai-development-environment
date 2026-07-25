export type CommandAgent = {
  id: string;
  name: string;
  hostname: string;
  connectionStatus: "ONLINE" | "OFFLINE";
  capabilities: string[];
};

export type CommandWorktree = {
  id: string;
  folder: string;
  branch: string | null;
  highlightColor: string | null;
  repositoryId?: string;
  repositoryName?: string;
  agentId?: string;
  agentName?: string;
};

export type CommandDefinition = {
  id: string;
  name: string;
  description: string;
  script: string;
  targetKind:
    | "ANY_AGENT_HOME"
    | "SPECIFIC_AGENT_HOME"
    | "ANY_WORKTREE"
    | "REPOSITORY_WORKTREE";
  targetAgentId: string | null;
  targetAgent: CommandAgent | null;
  targetRepositoryId: string | null;
  targetRepository: { id: string; name: string; displayOrigin: string } | null;
  restartPolicy: "NEVER" | "ON_FAILURE" | "ALWAYS";
  restartLimit: number | null;
  quickActionEnabled: boolean;
  quickActionIconKey: string;
  quickActionButtonVariant: string;
  notificationsEnabled: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CommandRunAttempt = {
  id: string;
  attempt: number;
  status: string;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type CommandRun = {
  id: string;
  displayNumber: number;
  commandId: string;
  command: Pick<CommandDefinition, "id" | "name">;
  origin: string;
  status: string;
  snapshotName: string;
  snapshotDescription: string;
  snapshotScript: string;
  snapshotTargetKind: string;
  snapshotRestartPolicy: string;
  snapshotRestartLimit: number | null;
  snapshotNotificationsEnabled: boolean;
  snapshot: Record<string, unknown>;
  agentId: string | null;
  agent: CommandAgent | null;
  worktreeId: string | null;
  worktree: CommandWorktree | null;
  agentName: string;
  agentHostname: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  restartCount: number;
  stopRequested: boolean;
  nextRestartAt: string | null;
  predecessorRunId: string | null;
  predecessor: { id: string; displayNumber: number } | null;
  successor: { id: string; displayNumber: number } | null;
  error: string | null;
  exitCode: number | null;
  signal: string | null;
  attempts: CommandRunAttempt[];
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const COMMAND_DEFINITION_FIELDS = `
  id name description script targetKind targetAgentId targetRepositoryId
  restartPolicy restartLimit quickActionEnabled quickActionIconKey quickActionButtonVariant
  notificationsEnabled
  archivedAt createdAt updatedAt
  targetAgent { id name hostname connectionStatus capabilities }
  targetRepository { id name displayOrigin }
`;

export const COMMAND_RUN_FIELDS = `
  id displayNumber commandId origin status snapshotName snapshotDescription
  snapshotScript snapshotTargetKind snapshotRestartPolicy snapshotRestartLimit
  snapshotNotificationsEnabled snapshot
  agentId worktreeId agentName agentHostname worktreePath worktreeBranch
  restartCount stopRequested nextRestartAt predecessorRunId error exitCode signal
  queuedAt startedAt finishedAt archivedAt createdAt updatedAt
  command { id name }
  agent { id name hostname connectionStatus capabilities }
  worktree { id folder branch highlightColor }
  attempts { id attempt status exitCode signal error startedAt finishedAt }
`;

export const activeCommandRun = (status: string) =>
  ["QUEUED", "RUNNING", "RESTARTING", "CANCELLING"].includes(status);

export const commandStatusKey = (status: string) => {
  switch (status) {
    case "QUEUED":
      return "statusQueued" as const;
    case "RUNNING":
      return "statusRunning" as const;
    case "RESTARTING":
      return "statusRestarting" as const;
    case "CANCELLING":
      return "statusCancelling" as const;
    case "SUCCEEDED":
      return "statusSucceeded" as const;
    case "FAILED":
      return "statusFailed" as const;
    case "CANCELLED":
      return "statusCancelled" as const;
    case "TIMED_OUT":
      return "statusTimedOut" as const;
    default:
      return "status" as const;
  }
};

export const commandOriginKey = (origin: string) => {
  switch (origin) {
    case "QUICK_ACTION":
      return "originQuickAction" as const;
    case "WORKFLOW":
      return "originWorkflow" as const;
    case "RERUN":
      return "originRerun" as const;
    default:
      return "originManual" as const;
  }
};

export const commandTargetKey = (target: string) => {
  switch (target) {
    case "ANY_AGENT_HOME":
      return "anyAgentHome" as const;
    case "SPECIFIC_AGENT_HOME":
      return "specificAgentHome" as const;
    case "REPOSITORY_WORKTREE":
      return "repositoryWorktree" as const;
    default:
      return "anyWorktree" as const;
  }
};

export const commandRestartKey = (policy: string) => {
  switch (policy) {
    case "ON_FAILURE":
      return "onFailure" as const;
    case "ALWAYS":
      return "always" as const;
    default:
      return "never" as const;
  }
};
