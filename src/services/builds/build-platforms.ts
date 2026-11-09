import {
  BUILD_ACTIONS,
  buildDestinationPlatform,
  parseBuildAdvancedSettings,
  parseBuildDestination,
  parseBuildExportSettings,
  parseBuildSource,
  type BuildAction,
  type BuildExportSettings,
  type BuildPlatform,
  type BuildSourceKind,
} from "@ai-development-environment/agent-contract/builds";

const buildPlatforms = [
  "IOS",
  "TVOS",
  "VISIONOS",
  "WATCHOS",
  "MACOS",
  "MAC_CATALYST",
] as const;

export type BuildPlatformConfigurationInput = {
  platform: BuildPlatform;
  sourceKind?: BuildSourceKind | null;
  sourcePath?: string | null;
  scheme?: string | null;
  buildConfiguration?: string | null;
  defaultAction?: BuildAction | null;
  advancedSettings?: unknown;
  autoExport?: boolean | null;
  exportSettings?: unknown;
};

export function requireBuildPlatform(platform: BuildPlatform) {
  if (!(buildPlatforms as readonly BuildPlatform[]).includes(platform)) {
    throw new Error("Select a supported Apple build platform");
  }
  return platform;
}

export function isMacBuildPlatform(platform: BuildPlatform) {
  return platform === "MACOS" || platform === "MAC_CATALYST";
}

const platformNames: Record<BuildPlatform, string> = {
  IOS: "iOS",
  TVOS: "tvOS",
  VISIONOS: "visionOS",
  WATCHOS: "watchOS",
  MACOS: "macOS",
  MAC_CATALYST: "Mac Catalyst",
  MACOS_DESIGNED_FOR_IPAD: "macOS (Designed for iPad)",
  VISIONOS_DESIGNED_FOR_IPAD: "visionOS (Designed for iPad)",
};

export function buildPlatformName(platform: BuildPlatform | null) {
  return platform ? platformNames[platform] : "Xcode";
}

export function buildPlatformExportSettings(
  platform: BuildPlatform,
  value: unknown,
) {
  const settings = parseBuildExportSettings(value);
  const method: string = settings.method;
  const macOnly = method === "MAC_APPLICATION" || method === "DEVELOPER_ID";
  if (
    (isMacBuildPlatform(platform) &&
      !macOnly &&
      method !== "APP_STORE_CONNECT") ||
    (!isMacBuildPlatform(platform) && macOnly)
  ) {
    throw new Error(`Export method ${method} is unavailable for ${platform}`);
  }
  return settings;
}

export function resolvePlatformExportSettings(
  platform: BuildPlatform,
  shared: BuildExportSettings | null,
  override: unknown,
) {
  if (override == null) return shared;
  if (typeof override !== "object" || Array.isArray(override)) {
    throw new Error("Platform export settings must be an object");
  }
  return buildPlatformExportSettings(platform, { ...shared, ...override });
}

function optionalLabel(value: string | null | undefined, label: string) {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) {
    throw new Error(`${label} must contain 1 to 256 characters`);
  }
  return trimmed;
}

export function parsePlatformConfigurations(
  entries: readonly BuildPlatformConfigurationInput[],
  sharedExportSettings: BuildExportSettings | null,
) {
  if (
    !entries.length ||
    new Set(entries.map(({ platform }) => platform)).size !== entries.length
  ) {
    throw new Error(
      "Select at least one build platform and list each platform once",
    );
  }
  return entries.map((entry) => {
    const platform = requireBuildPlatform(entry.platform);
    if ((entry.sourceKind == null) !== (entry.sourcePath == null)) {
      throw new Error("A platform source requires both kind and path");
    }
    const source = entry.sourceKind
      ? parseBuildSource({
          kind: entry.sourceKind,
          relativePath: entry.sourcePath,
        })
      : null;
    if (
      entry.defaultAction != null &&
      !BUILD_ACTIONS.includes(entry.defaultAction)
    ) {
      throw new Error("Platform build action is invalid");
    }
    const advanced =
      entry.advancedSettings == null
        ? undefined
        : parseBuildAdvancedSettings(entry.advancedSettings);
    const advancedSettings =
      advanced &&
      Object.fromEntries(
        Object.entries(advanced).filter(([key]) =>
          Object.hasOwn(entry.advancedSettings as object, key),
        ),
      );
    const effectiveExportSettings = resolvePlatformExportSettings(
      platform,
      sharedExportSettings,
      entry.exportSettings,
    );
    return {
      platform,
      sourceKind: source?.kind,
      sourcePath: source?.relativePath,
      scheme: optionalLabel(entry.scheme, "Scheme"),
      buildConfiguration: optionalLabel(
        entry.buildConfiguration,
        "Xcode configuration",
      ),
      defaultAction: entry.defaultAction ?? undefined,
      advancedSettings,
      autoExport: entry.autoExport ?? undefined,
      exportSettings:
        entry.exportSettings != null && effectiveExportSettings
          ? Object.fromEntries(
              Object.entries(effectiveExportSettings).filter(([key]) =>
                Object.hasOwn(entry.exportSettings as object, key),
              ),
            )
          : undefined,
    };
  });
}

export function storedPlatformConfigurations(
  value?: string | null,
): BuildPlatformConfigurationInput[] {
  const entries = value ? (JSON.parse(value) as unknown) : null;
  return Array.isArray(entries) && entries.length
    ? (entries as BuildPlatformConfigurationInput[])
    : [{ platform: "IOS" }];
}

export function storedBuildPlatform(build: {
  destinationJson?: string;
  destinationType?: string;
}): BuildPlatform | null {
  if (build.destinationType === "HOST") return null;
  if (!build.destinationJson) return "IOS";
  try {
    return buildDestinationPlatform(
      parseBuildDestination(JSON.parse(build.destinationJson)),
    );
  } catch {
    return "IOS";
  }
}
