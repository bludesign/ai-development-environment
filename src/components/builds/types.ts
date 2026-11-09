import {
  buildPlatformForXcode,
  type BuildAction,
  type BuildDestination,
  type BuildPlatform as RunPlatform,
} from "@ai-development-environment/agent-contract/builds";

export type { BuildAction, BuildDestination, RunPlatform };

export const BUILD_PLATFORMS = [
  "IOS",
  "TVOS",
  "VISIONOS",
  "WATCHOS",
  "MACOS",
  "MAC_CATALYST",
] as const;

export type BuildPlatform = (typeof BUILD_PLATFORMS)[number];

const PLATFORM_LABELS: Record<RunPlatform, string> = {
  IOS: "iOS",
  TVOS: "tvOS",
  VISIONOS: "visionOS",
  WATCHOS: "watchOS",
  MACOS: "macOS",
  MAC_CATALYST: "Mac Catalyst",
  MACOS_DESIGNED_FOR_IPAD: "Mac (Designed for iPad)",
  VISIONOS_DESIGNED_FOR_IPAD: "Apple Vision (Designed for iPad)",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform as RunPlatform] ?? platform;
}

export function destinationPlatform(
  destination: BuildDestination,
): RunPlatform {
  return (
    destination.platformId ??
    buildPlatformForXcode(destination.platform ?? "", destination.variant) ??
    "IOS"
  );
}

export function destinationKey(destination: BuildDestination): string {
  return `${destinationPlatform(destination)}:${destination.type}:${destination.id}`;
}

export type BuildRunAgent = {
  agent: {
    id: string;
    name: string;
    hostname: string;
    osVersion: string;
    architecture: string;
    connectionStatus: "ONLINE" | "OFFLINE";
  };
  isBuildAgent: boolean;
  available: boolean;
  unavailableReason:
    | "OFFLINE"
    | "AGENT_UPDATE_REQUIRED"
    | "BUILD_AGENT_UNAVAILABLE"
    | "INCOMPATIBLE_ARCHITECTURE"
    | "LOCAL_MAC_ONLY"
    | "NOT_MACOS"
    | null;
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

export type BuildPlatformConfiguration = {
  platform: BuildPlatform;
  sourceKind?: BuildConfiguration["source"]["kind"] | null;
  sourcePath?: string | null;
  scheme?: string | null;
  buildConfiguration?: string | null;
  defaultAction?: BuildAction | null;
  advancedSettings?: Record<string, unknown> | null;
  autoExport?: boolean | null;
  exportSettings?: Record<string, unknown> | null;
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
  autoExport?: boolean;
  exportSettings?: Record<string, unknown> | null;
  platformConfigurations?: BuildPlatformConfiguration[];
  observation: BuildSourceObservation | null;
  createdAt: string;
  updatedAt: string;
};

export function configurationPlatforms(configuration: BuildConfiguration) {
  const entries = configuration.platformConfigurations?.filter(({ platform }) =>
    BUILD_PLATFORMS.includes(platform),
  );
  return entries?.length
    ? entries
    : [{ platform: "IOS" } satisfies BuildPlatformConfiguration];
}

export function settingsForPlatform(
  configuration: BuildConfiguration,
  platform: BuildPlatform,
): BuildConfiguration {
  const entry = configurationPlatforms(configuration).find(
    (item) => item.platform === platform,
  );
  if (!entry) return configuration;
  return {
    ...configuration,
    source: {
      ...configuration.source,
      kind: entry.sourceKind ?? configuration.source.kind,
      relativePath: entry.sourcePath ?? configuration.source.relativePath,
    },
    scheme: entry.scheme ?? configuration.scheme,
    buildConfiguration:
      entry.buildConfiguration ?? configuration.buildConfiguration,
    defaultAction: entry.defaultAction ?? configuration.defaultAction,
    advancedSettings: {
      ...configuration.advancedSettings,
      ...entry.advancedSettings,
    },
    autoExport: entry.autoExport ?? configuration.autoExport,
    exportSettings: {
      ...configuration.exportSettings,
      ...entry.exportSettings,
    },
    observation:
      entry.sourceKind ||
      entry.sourcePath ||
      entry.scheme ||
      entry.buildConfiguration
        ? null
        : configuration.observation,
  };
}

export type BuildScript = {
  iconKey?: string | null;
  repositories?: Array<{ id: string; name: string }>;
  id: string;
  name: string;
  preBuildScript: string | null;
  postBuildScript: string | null;
  enabledByDefault: boolean;
  timeoutSeconds: number;
  failureBehavior: "FAIL_BUILD" | "CONTINUE";
  lockScope?: "WORKTREE" | "CODEBASE" | "AGENT";
};

export type IosAppProject = {
  id: string;
  type: "IOS_APP";
  defaultDestinationType: "SIMULATOR" | "PHYSICAL_DEVICE";
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
  blockedReason?: string | null;
  id: string;
  requestId: string;
  jobId: string | null;
  status:
    "QUEUED" | "PREPARING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  action: BuildAction;
  // HOST covers records that ran no device build, such as an imported
  // coverage report; no build destination ever carries it.
  destinationType: BuildDestination["type"] | "HOST";
  platform?: BuildPlatform | null;
  destination: BuildDestination;
  snapshot: Record<string, unknown>;
  commandSummary: string;
  artifactDirectory: string;
  errorCode: string | null;
  warnings?: string[];
  error: string | null;
  outOfDate: boolean;
  worktree?: { id: string; highlightColor: string | null } | null;
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
    targetAgent?: BuildRunAgent["agent"] | null;
    transfer?: {
      id: string;
      status: string;
      uploadOffset: number;
      uploadLength: number | null;
      downloadOffset: number;
      error: string | null;
    } | null;
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

export type BuildLogChunk = {
  id: string;
  scope: string;
  scopeId: string;
  sequence: number;
  phase: string;
  stream: string;
  dataBase64: string;
  byteLength: number;
  createdAt: string;
};
