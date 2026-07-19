export type BuildAction =
  | "BUILD"
  | "TEST"
  | "ANALYZE"
  | "ARCHIVE"
  | "BUILD_FOR_TESTING"
  | "TEST_WITHOUT_BUILDING";

export type BuildDestination = {
  type: "SIMULATOR" | "PHYSICAL_DEVICE";
  id: string;
  name: string;
  platform: string;
  osVersion: string | null;
  state: string | null;
  generic?: boolean;
};

export type BuildSourceObservation = {
  id: string;
  scopeKey: string;
  status: "UNPARSED" | "PARSING" | "VALID" | "INVALID" | "ERROR";
  schemes: string[];
  configurations: string[];
  testPlans: string[];
  error: string | null;
  stale: boolean;
  headSha: string | null;
  xcodeVersion: string | null;
  lastParseAttemptAt: string;
  lastParsedAt: string | null;
};

export type BuildConfiguration = {
  id: string;
  name: string;
  iconKey: string | null;
  source: {
    id: string;
    kind: "PROJECT" | "WORKSPACE" | "PACKAGE";
    relativePath: string;
  };
  scheme: string;
  buildConfiguration: string;
  defaultAction: BuildAction;
  advancedSettings: Record<string, unknown>;
  observation: BuildSourceObservation | null;
  createdAt: string;
  updatedAt: string;
};

export type BuildScript = {
  id: string;
  name: string;
  preBuildScript: string | null;
  postBuildScript: string | null;
  enabledByDefault: boolean;
  timeoutSeconds: number;
  failureBehavior: "FAIL_BUILD" | "CONTINUE";
};

export type IosAppProject = {
  id: string;
  type: "IOS_APP";
  configurations: BuildConfiguration[];
  allowedScripts: Array<{ position: number; script: BuildScript }>;
};

export type BuildArtifact = {
  id: string;
  kind: string;
  relativePath: string;
  sizeBytes: number | null;
  checksum: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type BuildReport = {
  id: string;
  kind: "TEST_RESULTS" | "CODE_COVERAGE";
  source: "AUTOMATIC" | "MANUAL" | "WORKTREE";
  status: "PENDING" | "READY" | "FAILED";
  summary: Record<string, unknown>;
  data: Record<string, unknown>;
  error: string | null;
  artifact: BuildArtifact | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type BuildRecord = {
  id: string;
  requestId: string;
  jobId: string | null;
  status:
    "QUEUED" | "PREPARING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  action: BuildAction;
  destinationType: "SIMULATOR" | "PHYSICAL_DEVICE";
  destination: BuildDestination;
  snapshot: Record<string, unknown>;
  commandSummary: string;
  artifactDirectory: string;
  errorCode: string | null;
  error: string | null;
  outOfDate: boolean;
  artifacts: BuildArtifact[];
  reports?: BuildReport[];
  scriptExecutions: Array<{
    id: string;
    phase: string;
    position: number;
    nameSnapshot: string;
    status: string;
    exitCode: number | null;
    durationMs: number | null;
    causedBuildFailure: boolean;
    outputRelativePath: string | null;
    error: string | null;
  }>;
  deployments: Array<{
    id: string;
    batchId: string;
    destination: BuildDestination;
    status: string;
    commandSummary: string;
    outputRelativePath: string | null;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  exports: Array<{
    id: string;
    status: string;
    settings: Record<string, unknown>;
    commandSummary: string;
    outputRelativePath: string | null;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  configuration: BuildConfiguration | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  updatedAt: string;
};

export type BuildLogEvent = {
  id: string;
  scope: string;
  scopeId: string;
  sequence: number;
  phase: string;
  level: string;
  stream: string;
  message: string;
  createdAt: string;
};
