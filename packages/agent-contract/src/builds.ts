export const IOS_SOURCE_DISCOVER_JOB_KIND = "ios.source.discover";
export const IOS_SOURCE_PARSE_JOB_KIND = "ios.source.parse";
export const IOS_DESTINATIONS_JOB_KIND = "ios.destinations.inspect";
export const IOS_RUN_DESTINATIONS_JOB_KIND = "ios.runDestinations.inspect";
export const IOS_BUILD_JOB_KIND = "ios.build.run";
export const IOS_BUILD_DELETE_JOB_KIND = "ios.build.delete";
export const IOS_ARTIFACT_DOWNLOAD_JOB_KIND = "ios.artifact.download";
export const IOS_DEPLOY_JOB_KIND = "ios.build.deploy";
export const IOS_EXPORT_JOB_KIND = "ios.archive.export";
export const IOS_TEST_RESULTS_JOB_KIND = "ios.test-results.parse";
export const IOS_COVERAGE_REPORT_JOB_KIND = "ios.coverage.generate";
export const IOS_SIGNING_INSPECT_JOB_KIND = "ios.signing.inspect";

export const IOS_BUILD_JOB_KINDS = [
  IOS_SOURCE_DISCOVER_JOB_KIND,
  IOS_SOURCE_PARSE_JOB_KIND,
  IOS_DESTINATIONS_JOB_KIND,
  IOS_RUN_DESTINATIONS_JOB_KIND,
  IOS_BUILD_JOB_KIND,
  IOS_BUILD_DELETE_JOB_KIND,
  IOS_ARTIFACT_DOWNLOAD_JOB_KIND,
  IOS_DEPLOY_JOB_KIND,
  IOS_EXPORT_JOB_KIND,
  IOS_TEST_RESULTS_JOB_KIND,
  IOS_COVERAGE_REPORT_JOB_KIND,
  IOS_SIGNING_INSPECT_JOB_KIND,
] as const;

export const BUILD_ACTIONS = [
  "BUILD",
  "TEST",
  "ANALYZE",
  "ARCHIVE",
  "BUILD_FOR_TESTING",
  "TEST_WITHOUT_BUILDING",
] as const;
export type BuildAction = (typeof BUILD_ACTIONS)[number];

export const GENERIC_BUILD_DESTINATION_ACTIONS: readonly BuildAction[] = [
  "BUILD",
  "ANALYZE",
  "ARCHIVE",
  "BUILD_FOR_TESTING",
];

export const BUILD_SOURCE_KINDS = ["PROJECT", "WORKSPACE", "PACKAGE"] as const;
export type BuildSourceKind = (typeof BUILD_SOURCE_KINDS)[number];

export const BUILD_CONFIGURATION_ICON_KEYS = [
  "apple",
  "app-window",
  "archive",
  "beaker",
  "box",
  "bug",
  "code",
  "gauge",
  "hammer",
  "layers",
  "package",
  "play",
  "rocket",
  "shield",
  "smartphone",
  "sparkles",
  "terminal",
  "test-tube",
  "wrench",
] as const;
export type BuildConfigurationIconKey =
  (typeof BUILD_CONFIGURATION_ICON_KEYS)[number];

export const BUILD_DESTINATION_TYPES = [
  "SIMULATOR",
  "PHYSICAL_DEVICE",
] as const;
export type BuildDestinationType = (typeof BUILD_DESTINATION_TYPES)[number];

export const BUILD_SCRIPT_FAILURE_BEHAVIORS = [
  "FAIL_BUILD",
  "CONTINUE",
] as const;
export type BuildScriptFailureBehavior =
  (typeof BUILD_SCRIPT_FAILURE_BEHAVIORS)[number];

export const APPROVED_BUILD_SETTING_OVERRIDES = [
  "ONLY_ACTIVE_ARCH",
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS",
  "SWIFT_OPTIMIZATION_LEVEL",
  "GCC_PREPROCESSOR_DEFINITIONS",
  "OTHER_SWIFT_FLAGS",
  "ENABLE_TESTABILITY",
  "DEBUG_INFORMATION_FORMAT",
  "VALIDATE_PRODUCT",
  "MARKETING_VERSION",
  "CURRENT_PROJECT_VERSION",
] as const;
export type ApprovedBuildSettingOverride =
  (typeof APPROVED_BUILD_SETTING_OVERRIDES)[number];

export type BuildSourceSnapshot = {
  kind: BuildSourceKind;
  relativePath: string;
};

export type BuildDestination = {
  type: BuildDestinationType;
  id: string;
  name: string;
  platform: string;
  osVersion: string | null;
  state: string | null;
  generic?: boolean;
};

export type BuildAdvancedSettings = {
  packageResolution:
    "DEFAULT" | "RESOLVED_ONLY" | "SKIP_UPDATES" | "DISABLE_AUTOMATIC";
  disablePackageRepositoryCache: boolean;
  signingStyle: "PROJECT_DEFAULT" | "AUTOMATIC" | "MANUAL";
  developmentTeam: string | null;
  codeSignIdentity: string | null;
  provisioningProfileSpecifier: string | null;
  productBundleIdentifier: string | null;
  allowProvisioningUpdates: boolean;
  allowProvisioningDeviceRegistration: boolean;
  testPlan: string | null;
  codeCoverage: boolean;
  parseTestResults: boolean;
  parallelTesting: boolean | null;
  parallelTestingWorkers: number | null;
  onlyTesting: string[];
  skipTesting: string[];
  buildSettingOverrides: Partial<Record<ApprovedBuildSettingOverride, string>>;
  priorBuildForTestingId: string | null;
  priorTestProductsPath: string | null;
  priorXctestrunPath: string | null;
};

export const DEFAULT_BUILD_ADVANCED_SETTINGS: BuildAdvancedSettings = {
  packageResolution: "DEFAULT",
  disablePackageRepositoryCache: false,
  signingStyle: "PROJECT_DEFAULT",
  developmentTeam: null,
  codeSignIdentity: null,
  provisioningProfileSpecifier: null,
  productBundleIdentifier: null,
  allowProvisioningUpdates: false,
  allowProvisioningDeviceRegistration: false,
  testPlan: null,
  codeCoverage: false,
  parseTestResults: true,
  parallelTesting: null,
  parallelTestingWorkers: null,
  onlyTesting: [],
  skipTesting: [],
  buildSettingOverrides: {},
  priorBuildForTestingId: null,
  priorTestProductsPath: null,
  priorXctestrunPath: null,
};

export type BuildScriptSnapshot = {
  id: string;
  name: string;
  preBuildScript: string | null;
  postBuildScript: string | null;
  timeoutSeconds: number;
  failureBehavior: BuildScriptFailureBehavior;
  position: number;
};

export type BuildTelemetrySettings = {
  localBaseUrl: string;
  remoteBaseUrl: string;
  selectedBaseUrl: string;
  consoleLogsUrl: string;
  analyticsEventsUrl: string;
  consoleCollectionEnabled: boolean;
  analyticsCollectionEnabled: boolean;
};

export type BuildWorktreeIdentity = {
  codebaseId: string;
  worktreeId: string;
  branch?: string | null;
  folder: string;
  gitDirectory: string;
  expectedOrigin: string;
  headSha: string | null;
  baseBranch?: string | null;
};

export type BuildSourceDiscoverPayload = BuildWorktreeIdentity;
export type BuildSourceParsePayload = BuildWorktreeIdentity & {
  source: BuildSourceSnapshot;
  scheme: string | null;
  configuration: string | null;
};
export type BuildDestinationsPayload = BuildWorktreeIdentity & {
  source: BuildSourceSnapshot;
  scheme: string;
  configuration: string;
  action: BuildAction;
};
export type BuildRunDestinationsPayload = BuildWorktreeIdentity & {
  destinationType: BuildDestinationType;
};

export type BuildJobPayload = BuildWorktreeIdentity & {
  buildId: string;
  artifactDirectory: string;
  source: BuildSourceSnapshot;
  scheme: string;
  configuration: string;
  action: BuildAction;
  destination: BuildDestination;
  advancedSettings: BuildAdvancedSettings;
  scripts: BuildScriptSnapshot[];
  /** Optional only for jobs queued by a server version that predates telemetry. */
  telemetry?: BuildTelemetrySettings;
  worktreeCoverage?: boolean;
};

export const BUILD_REPORT_KINDS = ["TEST_RESULTS", "CODE_COVERAGE"] as const;
export type BuildReportKind = (typeof BUILD_REPORT_KINDS)[number];

export type BuildReportPayload = BuildDeletePayload & {
  reportKind: BuildReportKind;
  source: "MANUAL" | "WORKTREE";
};

export type BuildDeploymentPayload = BuildWorktreeIdentity & {
  buildId: string;
  artifactDirectory: string;
  artifactRelativePath: string;
  bundleIdentifier: string;
  deployments: Array<{ id: string; destination: BuildDestination }>;
};

export type BuildDeletePayload = {
  buildId: string;
  artifactDirectory: string;
  codebaseId: string;
};

export type BuildArtifactDownloadPayload = BuildDeletePayload & {
  artifactRelativePath: string;
  uploadId: string;
};

export type BuildExportSettings = {
  method: "DEBUGGING" | "RELEASE_TESTING" | "ENTERPRISE" | "APP_STORE_CONNECT";
  signingStyle: "AUTOMATIC" | "MANUAL";
  teamId: string | null;
  signingCertificate: string | null;
  provisioningProfiles: Record<string, string>;
  uploadSymbols: boolean;
  manageAppVersionAndBuildNumber: boolean;
  testFlightInternalTestingOnly: boolean;
  stripSwiftSymbols: boolean;
  thinning: string | null;
  iCloudContainerEnvironment: "Development" | "Production" | null;
  distributionBundleIdentifier: string | null;
};

export type BuildArtifactSnapshot = {
  kind: string;
  relativePath: string;
  sizeBytes: number | null;
  checksum: string | null;
  metadata: Record<string, unknown>;
};

export type BuildExportPayload = BuildWorktreeIdentity & {
  buildId: string;
  exportId: string;
  artifactDirectory: string;
  archiveRelativePath: string;
  settings: BuildExportSettings;
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null || value === undefined
    ? null
    : stringValue(value, name);
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T[number];
}

function safeRelativePath(value: unknown, name: string): string {
  const path = stringValue(value, name);
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.split(/[\\/]/).includes("..") ||
    path.includes("\0")
  ) {
    throw new Error(`${name} must stay within the worktree`);
  }
  return path.replaceAll("\\", "/");
}

function safeAbsolutePath(value: unknown, name: string): string {
  const path = stringValue(value, name);
  if (
    !path.startsWith("/") ||
    path.split("/").includes("..") ||
    path.includes("\0")
  ) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return path;
}

function worktreeIdentity(value: JsonObject): BuildWorktreeIdentity {
  return {
    codebaseId: stringValue(value.codebaseId, "build payload.codebaseId"),
    worktreeId: stringValue(value.worktreeId, "build payload.worktreeId"),
    branch: nullableString(value.branch, "build payload.branch"),
    folder: stringValue(value.folder, "build payload.folder"),
    gitDirectory: stringValue(value.gitDirectory, "build payload.gitDirectory"),
    expectedOrigin: stringValue(
      value.expectedOrigin,
      "build payload.expectedOrigin",
    ),
    headSha: nullableString(value.headSha, "build payload.headSha"),
    baseBranch: nullableString(value.baseBranch, "build payload.baseBranch"),
  };
}

export function parseBuildSource(value: unknown): BuildSourceSnapshot {
  const source = objectValue(value, "build source");
  const kind = enumValue(source.kind, BUILD_SOURCE_KINDS, "build source.kind");
  const relativePath = safeRelativePath(
    source.relativePath,
    "build source.relativePath",
  );
  if (kind === "PROJECT" && !relativePath.endsWith(".xcodeproj")) {
    throw new Error("Project sources must end in .xcodeproj");
  }
  if (kind === "WORKSPACE" && !relativePath.endsWith(".xcworkspace")) {
    throw new Error("Workspace sources must end in .xcworkspace");
  }
  if (kind === "PACKAGE" && relativePath !== "Package.swift") {
    throw new Error("Package.swift must be at the worktree root");
  }
  return { kind, relativePath };
}

export function parseBuildDestination(value: unknown): BuildDestination {
  const destination = objectValue(value, "build destination");
  return {
    type: enumValue(
      destination.type,
      BUILD_DESTINATION_TYPES,
      "build destination.type",
    ),
    id: stringValue(destination.id, "build destination.id"),
    name: stringValue(destination.name, "build destination.name"),
    platform: stringValue(destination.platform, "build destination.platform"),
    osVersion: nullableString(
      destination.osVersion,
      "build destination.osVersion",
    ),
    state: nullableString(destination.state, "build destination.state"),
    ...(destination.generic === undefined
      ? {}
      : {
          generic: booleanValue(
            destination.generic,
            "build destination.generic",
          ),
        }),
  };
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => stringValue(item, `${name}[${index}]`));
}

export function parseBuildAdvancedSettings(
  value: unknown,
): BuildAdvancedSettings {
  const input = {
    ...DEFAULT_BUILD_ADVANCED_SETTINGS,
    ...objectValue(value ?? {}, "advanced settings"),
  } as JsonObject;
  const overrides = objectValue(
    input.buildSettingOverrides ?? {},
    "advanced settings.buildSettingOverrides",
  );
  const buildSettingOverrides: Partial<
    Record<ApprovedBuildSettingOverride, string>
  > = {};
  for (const [key, rawValue] of Object.entries(overrides)) {
    if (
      !(APPROVED_BUILD_SETTING_OVERRIDES as readonly string[]).includes(key)
    ) {
      throw new Error(`Build setting override ${key} is not approved`);
    }
    buildSettingOverrides[key as ApprovedBuildSettingOverride] = stringValue(
      rawValue,
      `advanced settings.buildSettingOverrides.${key}`,
    );
  }
  const workers = input.parallelTestingWorkers;
  if (
    workers !== null &&
    workers !== undefined &&
    (typeof workers !== "number" ||
      !Number.isInteger(workers) ||
      workers < 1 ||
      workers > 128)
  ) {
    throw new Error("parallelTestingWorkers must be between 1 and 128");
  }
  const parallel = input.parallelTesting;
  if (parallel !== null && typeof parallel !== "boolean") {
    throw new Error("parallelTesting must be a boolean or null");
  }
  return {
    packageResolution: enumValue(
      input.packageResolution,
      [
        "DEFAULT",
        "RESOLVED_ONLY",
        "SKIP_UPDATES",
        "DISABLE_AUTOMATIC",
      ] as const,
      "advanced settings.packageResolution",
    ),
    disablePackageRepositoryCache: booleanValue(
      input.disablePackageRepositoryCache,
      "advanced settings.disablePackageRepositoryCache",
    ),
    signingStyle: enumValue(
      input.signingStyle,
      ["PROJECT_DEFAULT", "AUTOMATIC", "MANUAL"] as const,
      "advanced settings.signingStyle",
    ),
    developmentTeam: nullableString(
      input.developmentTeam,
      "advanced settings.developmentTeam",
    ),
    codeSignIdentity: nullableString(
      input.codeSignIdentity,
      "advanced settings.codeSignIdentity",
    ),
    provisioningProfileSpecifier: nullableString(
      input.provisioningProfileSpecifier,
      "advanced settings.provisioningProfileSpecifier",
    ),
    productBundleIdentifier: nullableString(
      input.productBundleIdentifier,
      "advanced settings.productBundleIdentifier",
    ),
    allowProvisioningUpdates: booleanValue(
      input.allowProvisioningUpdates,
      "advanced settings.allowProvisioningUpdates",
    ),
    allowProvisioningDeviceRegistration: booleanValue(
      input.allowProvisioningDeviceRegistration,
      "advanced settings.allowProvisioningDeviceRegistration",
    ),
    testPlan: nullableString(input.testPlan, "advanced settings.testPlan"),
    codeCoverage: booleanValue(
      input.codeCoverage,
      "advanced settings.codeCoverage",
    ),
    parseTestResults: booleanValue(
      input.parseTestResults,
      "advanced settings.parseTestResults",
    ),
    parallelTesting: parallel as boolean | null,
    parallelTestingWorkers: (workers ?? null) as number | null,
    onlyTesting: stringArray(
      input.onlyTesting,
      "advanced settings.onlyTesting",
    ),
    skipTesting: stringArray(
      input.skipTesting,
      "advanced settings.skipTesting",
    ),
    buildSettingOverrides,
    priorBuildForTestingId: nullableString(
      input.priorBuildForTestingId,
      "advanced settings.priorBuildForTestingId",
    ),
    priorTestProductsPath:
      input.priorTestProductsPath === null ||
      input.priorTestProductsPath === undefined
        ? null
        : safeAbsolutePath(
            input.priorTestProductsPath,
            "advanced settings.priorTestProductsPath",
          ),
    priorXctestrunPath:
      input.priorXctestrunPath === null ||
      input.priorXctestrunPath === undefined
        ? null
        : safeAbsolutePath(
            input.priorXctestrunPath,
            "advanced settings.priorXctestrunPath",
          ),
  };
}

function parseScript(value: unknown, index: number): BuildScriptSnapshot {
  const script = objectValue(value, `build scripts[${index}]`);
  const timeout = script.timeoutSeconds;
  const position = script.position;
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 3_600
  ) {
    throw new Error(`build scripts[${index}].timeoutSeconds is invalid`);
  }
  if (
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    position < 0
  ) {
    throw new Error(`build scripts[${index}].position is invalid`);
  }
  return {
    id: stringValue(script.id, `build scripts[${index}].id`),
    name: stringValue(script.name, `build scripts[${index}].name`),
    preBuildScript: nullableString(
      script.preBuildScript,
      `build scripts[${index}].preBuildScript`,
    ),
    postBuildScript: nullableString(
      script.postBuildScript,
      `build scripts[${index}].postBuildScript`,
    ),
    timeoutSeconds: timeout,
    failureBehavior: enumValue(
      script.failureBehavior,
      BUILD_SCRIPT_FAILURE_BEHAVIORS,
      `build scripts[${index}].failureBehavior`,
    ),
    position,
  };
}

function httpUrl(value: unknown, name: string): string {
  const text = stringValue(value, name);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  return url.toString().replace(/\/$/, "");
}

function parseBuildTelemetrySettings(
  value: unknown,
): BuildTelemetrySettings | undefined {
  if (value === undefined || value === null) return undefined;
  const input = objectValue(value, "build job payload.telemetry");
  return {
    localBaseUrl: httpUrl(
      input.localBaseUrl,
      "build job payload.telemetry.localBaseUrl",
    ),
    remoteBaseUrl: httpUrl(
      input.remoteBaseUrl,
      "build job payload.telemetry.remoteBaseUrl",
    ),
    selectedBaseUrl: httpUrl(
      input.selectedBaseUrl,
      "build job payload.telemetry.selectedBaseUrl",
    ),
    consoleLogsUrl: httpUrl(
      input.consoleLogsUrl,
      "build job payload.telemetry.consoleLogsUrl",
    ),
    analyticsEventsUrl: httpUrl(
      input.analyticsEventsUrl,
      "build job payload.telemetry.analyticsEventsUrl",
    ),
    consoleCollectionEnabled: booleanValue(
      input.consoleCollectionEnabled,
      "build job payload.telemetry.consoleCollectionEnabled",
    ),
    analyticsCollectionEnabled: booleanValue(
      input.analyticsCollectionEnabled,
      "build job payload.telemetry.analyticsCollectionEnabled",
    ),
  };
}

export function parseBuildSourceDiscoverPayload(
  value: unknown,
): BuildSourceDiscoverPayload {
  return worktreeIdentity(objectValue(value, "source discovery payload"));
}

export function parseBuildSourceParsePayload(
  value: unknown,
): BuildSourceParsePayload {
  const input = objectValue(value, "source parse payload");
  return {
    ...worktreeIdentity(input),
    source: parseBuildSource(input.source),
    scheme: nullableString(input.scheme, "source parse payload.scheme"),
    configuration: nullableString(
      input.configuration,
      "source parse payload.configuration",
    ),
  };
}

export function parseBuildDestinationsPayload(
  value: unknown,
): BuildDestinationsPayload {
  const input = objectValue(value, "destinations payload");
  return {
    ...worktreeIdentity(input),
    source: parseBuildSource(input.source),
    scheme: stringValue(input.scheme, "destinations payload.scheme"),
    configuration: stringValue(
      input.configuration,
      "destinations payload.configuration",
    ),
    action: enumValue(
      input.action,
      BUILD_ACTIONS,
      "destinations payload.action",
    ),
  };
}

export function parseBuildRunDestinationsPayload(
  value: unknown,
): BuildRunDestinationsPayload {
  const input = objectValue(value, "run destinations payload");
  return {
    ...worktreeIdentity(input),
    destinationType: enumValue(
      input.destinationType,
      BUILD_DESTINATION_TYPES,
      "run destinations payload.destinationType",
    ),
  };
}

export function parseBuildJobPayload(value: unknown): BuildJobPayload {
  const input = objectValue(value, "build job payload");
  if (!Array.isArray(input.scripts)) {
    throw new Error("build job payload.scripts must be an array");
  }
  const scripts = input.scripts.map(parseScript);
  if (new Set(scripts.map((script) => script.id)).size !== scripts.length) {
    throw new Error("build job payload scripts must be unique");
  }
  const action = enumValue(
    input.action,
    BUILD_ACTIONS,
    "build job payload.action",
  );
  const destination = parseBuildDestination(input.destination);
  const advancedSettings = parseBuildAdvancedSettings(input.advancedSettings);
  if (
    action === "ARCHIVE" &&
    (destination.type !== "PHYSICAL_DEVICE" || destination.generic !== true)
  ) {
    throw new Error("Archive builds require a generic physical destination");
  }
  if (
    destination.generic &&
    !GENERIC_BUILD_DESTINATION_ACTIONS.includes(action)
  ) {
    throw new Error("This build action requires a concrete destination");
  }
  if (
    action === "TEST_WITHOUT_BUILDING" &&
    (!advancedSettings.priorBuildForTestingId ||
      (!advancedSettings.priorTestProductsPath &&
        !advancedSettings.priorXctestrunPath))
  ) {
    throw new Error(
      "Test Without Building requires a captured Build for Testing result",
    );
  }
  return {
    ...worktreeIdentity(input),
    buildId: stringValue(input.buildId, "build job payload.buildId"),
    artifactDirectory: stringValue(
      input.artifactDirectory,
      "build job payload.artifactDirectory",
    ),
    source: parseBuildSource(input.source),
    scheme: stringValue(input.scheme, "build job payload.scheme"),
    configuration: stringValue(
      input.configuration,
      "build job payload.configuration",
    ),
    action,
    destination,
    advancedSettings,
    scripts,
    telemetry: parseBuildTelemetrySettings(input.telemetry),
    worktreeCoverage:
      input.worktreeCoverage === undefined
        ? false
        : booleanValue(
            input.worktreeCoverage,
            "build job payload.worktreeCoverage",
          ),
  };
}

export function parseBuildReportPayload(value: unknown): BuildReportPayload {
  const input = objectValue(value, "build report payload");
  return {
    ...parseBuildDeletePayload(input),
    reportKind: enumValue(
      input.reportKind,
      BUILD_REPORT_KINDS,
      "build report payload.reportKind",
    ),
    source: enumValue(
      input.source,
      ["MANUAL", "WORKTREE"] as const,
      "build report payload.source",
    ),
  };
}

export function parseBuildDeletePayload(value: unknown): BuildDeletePayload {
  const input = objectValue(value, "build delete payload");
  const buildId = stringValue(input.buildId, "build delete payload.buildId");
  const artifactDirectory = safeAbsolutePath(
    input.artifactDirectory,
    "build delete payload.artifactDirectory",
  );
  if (artifactDirectory.split("/").at(-1) !== buildId) {
    throw new Error("Build delete folder must end with the build ID");
  }
  return {
    buildId,
    artifactDirectory,
    codebaseId: stringValue(
      input.codebaseId,
      "build delete payload.codebaseId",
    ),
  };
}

export function parseBuildArtifactDownloadPayload(
  value: unknown,
): BuildArtifactDownloadPayload {
  const input = objectValue(value, "build artifact download payload");
  const identity = parseBuildDeletePayload(input);
  return {
    ...identity,
    artifactRelativePath: safeRelativePath(
      input.artifactRelativePath,
      "build artifact download payload.artifactRelativePath",
    ),
    uploadId: stringValue(
      input.uploadId,
      "build artifact download payload.uploadId",
    ),
  };
}

export function parseBuildDeploymentPayload(
  value: unknown,
): BuildDeploymentPayload {
  const input = objectValue(value, "build deployment payload");
  if (!Array.isArray(input.deployments) || !input.deployments.length) {
    throw new Error("build deployment payload.deployments must not be empty");
  }
  const deployments = input.deployments.map((value, index) => {
    const deployment = objectValue(value, `deployments[${index}]`);
    return {
      id: stringValue(deployment.id, `deployments[${index}].id`),
      destination: parseBuildDestination(deployment.destination),
    };
  });
  if (new Set(deployments.map(({ id }) => id)).size !== deployments.length) {
    throw new Error("deployment payload IDs must be unique");
  }
  if (
    new Set(
      deployments.map(
        ({ destination }) => `${destination.type}:${destination.id}`,
      ),
    ).size !== deployments.length
  ) {
    throw new Error("deployment destinations must be unique");
  }
  if (
    new Set(deployments.map(({ destination }) => destination.type)).size > 1
  ) {
    throw new Error("deployment destinations must use one destination type");
  }
  return {
    ...worktreeIdentity(input),
    buildId: stringValue(input.buildId, "build deployment payload.buildId"),
    artifactDirectory: stringValue(
      input.artifactDirectory,
      "build deployment payload.artifactDirectory",
    ),
    artifactRelativePath: safeRelativePath(
      input.artifactRelativePath,
      "build deployment payload.artifactRelativePath",
    ),
    bundleIdentifier: stringValue(
      input.bundleIdentifier,
      "build deployment payload.bundleIdentifier",
    ),
    deployments,
  };
}

export function parseBuildExportSettings(value: unknown): BuildExportSettings {
  const input = objectValue(value, "export settings");
  const profiles = objectValue(
    input.provisioningProfiles ?? {},
    "export settings.provisioningProfiles",
  );
  return {
    method: enumValue(
      input.method,
      [
        "DEBUGGING",
        "RELEASE_TESTING",
        "ENTERPRISE",
        "APP_STORE_CONNECT",
      ] as const,
      "export settings.method",
    ),
    signingStyle: enumValue(
      input.signingStyle,
      ["AUTOMATIC", "MANUAL"] as const,
      "export settings.signingStyle",
    ),
    teamId: nullableString(input.teamId, "export settings.teamId"),
    signingCertificate: nullableString(
      input.signingCertificate,
      "export settings.signingCertificate",
    ),
    provisioningProfiles: Object.fromEntries(
      Object.entries(profiles).map(([key, profile]) => [
        stringValue(key, "export settings provisioning profile bundle id"),
        stringValue(profile, `export settings.provisioningProfiles.${key}`),
      ]),
    ),
    uploadSymbols: booleanValue(
      input.uploadSymbols,
      "export settings.uploadSymbols",
    ),
    manageAppVersionAndBuildNumber: booleanValue(
      input.manageAppVersionAndBuildNumber,
      "export settings.manageAppVersionAndBuildNumber",
    ),
    testFlightInternalTestingOnly: booleanValue(
      input.testFlightInternalTestingOnly,
      "export settings.testFlightInternalTestingOnly",
    ),
    stripSwiftSymbols:
      input.stripSwiftSymbols === undefined
        ? true
        : booleanValue(
            input.stripSwiftSymbols,
            "export settings.stripSwiftSymbols",
          ),
    thinning: nullableString(
      input.thinning ?? null,
      "export settings.thinning",
    ),
    iCloudContainerEnvironment:
      input.iCloudContainerEnvironment === null ||
      input.iCloudContainerEnvironment === undefined
        ? null
        : enumValue(
            input.iCloudContainerEnvironment,
            ["Development", "Production"] as const,
            "export settings.iCloudContainerEnvironment",
          ),
    distributionBundleIdentifier: nullableString(
      input.distributionBundleIdentifier ?? null,
      "export settings.distributionBundleIdentifier",
    ),
  };
}

export function parseBuildExportPayload(value: unknown): BuildExportPayload {
  const input = objectValue(value, "build export payload");
  return {
    ...worktreeIdentity(input),
    buildId: stringValue(input.buildId, "build export payload.buildId"),
    exportId: stringValue(input.exportId, "build export payload.exportId"),
    artifactDirectory: stringValue(
      input.artifactDirectory,
      "build export payload.artifactDirectory",
    ),
    archiveRelativePath: safeRelativePath(
      input.archiveRelativePath,
      "build export payload.archiveRelativePath",
    ),
    settings: parseBuildExportSettings(input.settings),
  };
}

/**
 * An artifact reported back by an agent in a job result. Job results are not
 * schema-validated on receipt, so the control plane parses them defensively:
 * invalid entries are skipped rather than failing the whole projection, and an
 * older agent that reports no artifacts at all yields an empty list.
 */
export function parseBuildArtifactSnapshots(
  value: unknown,
): BuildArtifactSnapshot[] {
  if (!Array.isArray(value)) return [];
  const snapshots: BuildArtifactSnapshot[] = [];
  for (const entry of value) {
    try {
      const input = objectValue(entry, "build artifact");
      snapshots.push({
        kind: stringValue(input.kind, "build artifact.kind"),
        relativePath: safeRelativePath(
          input.relativePath,
          "build artifact.relativePath",
        ),
        sizeBytes:
          typeof input.sizeBytes === "number" &&
          Number.isFinite(input.sizeBytes)
            ? input.sizeBytes
            : null,
        checksum: nullableString(input.checksum, "build artifact.checksum"),
        metadata:
          input.metadata &&
          typeof input.metadata === "object" &&
          !Array.isArray(input.metadata)
            ? (input.metadata as Record<string, unknown>)
            : {},
      });
    } catch {
      continue;
    }
  }
  return snapshots;
}

export const BUILD_EXPORT_METHODS = [
  "DEBUGGING",
  "RELEASE_TESTING",
  "ENTERPRISE",
  "APP_STORE_CONNECT",
] as const;
export type BuildExportMethod = (typeof BUILD_EXPORT_METHODS)[number];

export const PROVISIONING_PROFILE_TYPES = [
  "DEVELOPMENT",
  "AD_HOC",
  "ENTERPRISE",
  "APP_STORE",
] as const;
export type ProvisioningProfileType =
  (typeof PROVISIONING_PROFILE_TYPES)[number];

/** The profile type each distribution method requires. */
export const EXPORT_METHOD_PROFILE_TYPES: Record<
  BuildExportMethod,
  ProvisioningProfileType
> = {
  DEBUGGING: "DEVELOPMENT",
  RELEASE_TESTING: "AD_HOC",
  ENTERPRISE: "ENTERPRISE",
  APP_STORE_CONNECT: "APP_STORE",
};

/**
 * Classifies a profile the way Xcode does.
 *
 * `get-task-allow` is what separates a development profile from a distribution
 * one, and the device list separates ad hoc from store distribution. Enterprise
 * profiles carry no device list but claim every device instead.
 */
export function provisioningProfileType(profile: {
  getTaskAllow: boolean;
  hasProvisionedDevices: boolean;
  provisionsAllDevices: boolean;
}): ProvisioningProfileType {
  if (profile.getTaskAllow) return "DEVELOPMENT";
  if (profile.provisionsAllDevices) return "ENTERPRISE";
  return profile.hasProvisionedDevices ? "AD_HOC" : "APP_STORE";
}

/**
 * Whether a profile covers a bundle identifier, honouring the trailing wildcard
 * that team-wide profiles use.
 */
export function profileCoversBundle(
  profileBundleId: string,
  bundleId: string,
): boolean {
  if (profileBundleId === "*") return true;
  if (profileBundleId.endsWith(".*")) {
    return bundleId.startsWith(profileBundleId.slice(0, -1));
  }
  return profileBundleId === bundleId;
}

export type SigningTeam = { id: string; name: string };

export type SigningIdentity = {
  sha1: string;
  name: string;
  teamId: string | null;
};

export type SigningProfile = {
  uuid: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  bundleId: string;
  type: ProvisioningProfileType;
  platforms: string[];
  expiresAt: string | null;
  expired: boolean;
  xcodeManaged: boolean;
  /**
   * SHA-1 fingerprints of the certificates embedded in the profile, matching the
   * identifiers `security find-identity` reports. Export fails outright when the
   * chosen certificate is absent from the profile, so this is what decides which
   * certificates are actually offered.
   */
  certificateSha1s: string[];
};

export type ArchiveBundle = {
  bundleId: string;
  name: string;
  relativePath: string;
  embeddedProfileUuid: string | null;
  embeddedProfileName: string | null;
};

export type BuildSigningRequirement = {
  bundleId: string;
  name: string;
  target: string;
  platform: string | null;
  teamId: string | null;
  provisioningProfileSpecifier: string | null;
};

export type BuildSigningInspection = {
  teams: SigningTeam[];
  identities: SigningIdentity[];
  profiles: SigningProfile[];
  bundles: ArchiveBundle[];
};

export type BuildSigningInspectPayload = {
  buildId: string;
  codebaseId: string;
  artifactDirectory: string;
  archiveRelativePath: string;
};

export function parseBuildSigningInspectPayload(
  value: unknown,
): BuildSigningInspectPayload {
  const input = objectValue(value, "build signing payload");
  return {
    buildId: stringValue(input.buildId, "build signing payload.buildId"),
    codebaseId: stringValue(
      input.codebaseId,
      "build signing payload.codebaseId",
    ),
    artifactDirectory: stringValue(
      input.artifactDirectory,
      "build signing payload.artifactDirectory",
    ),
    archiveRelativePath: safeRelativePath(
      input.archiveRelativePath,
      "build signing payload.archiveRelativePath",
    ),
  };
}
