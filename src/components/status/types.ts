export type CliHealthCheck = {
  id: string;
  name: string;
  command: string;
  builtIn: boolean;
  state: "HEALTHY" | "UNHEALTHY" | "NOT_RUN";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number | null;
  checkedAt: string | null;
  timedOut: boolean;
  launchError: string | null;
  outputTruncated: boolean;
};

export type AgentCliHealthStatus = {
  agentId: string;
  name: string;
  hostname: string;
  version: string;
  connectionStatus: "ONLINE" | "OFFLINE";
  supported: boolean;
  activeJobId: string | null;
  lastCheckedAt: string | null;
  overall: "HEALTHY" | "ISSUES" | "NOT_CHECKED" | "RUNNING" | "UNSUPPORTED";
  results: CliHealthCheck[];
};

export type CustomCliHealthCheck = {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
};

export type InstallationStatus = {
  version: string;
  dependencies: Array<{ name: string; version: string }>;
  customChecks: CustomCliHealthCheck[];
  agents: AgentCliHealthStatus[];
};

export const CLI_HEALTH_RESULT_FIELDS = `
  id name command builtIn state exitCode stdout stderr durationMs checkedAt
  timedOut launchError outputTruncated
`;

export const AGENT_CLI_HEALTH_FIELDS = `
  agentId name hostname version connectionStatus supported activeJobId
  lastCheckedAt overall results { ${CLI_HEALTH_RESULT_FIELDS} }
`;

export const INSTALLATION_STATUS_FIELDS = `
  version
  dependencies { name version }
  customChecks { id name command enabled }
  agents { ${AGENT_CLI_HEALTH_FIELDS} }
`;
