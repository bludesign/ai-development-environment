import {
  parseDerivedDataLocationMode,
  type BuildDataScanEntryKind,
  type BuildDataWorktreeRoot,
  type DerivedDataLocationMode,
} from "@ai-development-environment/agent-contract/build-data";

export const DISK_SPACE_POLL_INTERVAL_SECONDS = 60;
export const DISK_SPACE_STALE_AFTER_SECONDS =
  DISK_SPACE_POLL_INTERVAL_SECONDS * 2;
export const DEFAULT_DISK_SPACE_THRESHOLD_GIB = 40;
export const DEFAULT_DISK_SPACE_PRESSURE_THRESHOLD_GIB = 10;

export const DISK_SPACE_VOLUME_ROLES = [
  "MAIN",
  "BASE_REPO",
  "DERIVED_DATA",
] as const;

export type DiskSpaceVolumeRole = (typeof DISK_SPACE_VOLUME_ROLES)[number];

export type AgentDiskSpaceConfiguration = {
  enabled: boolean;
  pollIntervalSeconds: number;
  baseRepoDirectory: string | null;
  derivedDataLocationMode: DerivedDataLocationMode;
  derivedDataPath: string | null;
  worktrees: BuildDataWorktreeRoot[];
};

export type AgentDiskSpaceVolumeReport = {
  id: string;
  totalBytes: number;
  freeBytes: number;
  roles: DiskSpaceVolumeRole[];
  paths: string[];
};

export type AgentDiskSpaceEntryReport = {
  path: string;
  rootPath: string;
  name: string;
  kind: BuildDataScanEntryKind;
  workspacePath: string | null;
  modifiedAt: string;
  volumeId: string;
};

export type AgentDiskSpaceReport = {
  observedAt: string;
  volumes: AgentDiskSpaceVolumeReport[];
  entries: AgentDiskSpaceEntryReport[];
  warnings: string[];
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function bytes(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name);
}

export function parseAgentDiskSpaceConfiguration(
  value: unknown,
): AgentDiskSpaceConfiguration {
  const input = objectValue(value, "disk space configuration");
  if (typeof input.enabled !== "boolean") {
    throw new Error("disk space configuration.enabled must be a boolean");
  }
  if (
    typeof input.pollIntervalSeconds !== "number" ||
    !Number.isInteger(input.pollIntervalSeconds) ||
    input.pollIntervalSeconds < 1
  ) {
    throw new Error("disk space poll interval is invalid");
  }
  if (!Array.isArray(input.worktrees) || input.worktrees.length > 10_000) {
    throw new Error("disk space configuration.worktrees is invalid");
  }
  return {
    enabled: input.enabled,
    pollIntervalSeconds: input.pollIntervalSeconds,
    baseRepoDirectory: nullableText(
      input.baseRepoDirectory,
      "disk space configuration.baseRepoDirectory",
    ),
    derivedDataLocationMode: parseDerivedDataLocationMode(
      input.derivedDataLocationMode,
    ),
    derivedDataPath: nullableText(
      input.derivedDataPath,
      "disk space configuration.derivedDataPath",
    ),
    worktrees: input.worktrees.map((raw, index) => {
      const worktree = objectValue(raw, `disk space worktrees[${index}]`);
      return {
        id: text(worktree.id, `disk space worktrees[${index}].id`),
        folder: text(worktree.folder, `disk space worktrees[${index}].folder`),
      };
    }),
  };
}

export function parseAgentDiskSpaceReport(
  value: unknown,
): AgentDiskSpaceReport {
  const input = objectValue(value, "disk space report");
  const observedAt = text(input.observedAt, "disk space report.observedAt");
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new Error("disk space report.observedAt must be an ISO date");
  }
  if (
    !Array.isArray(input.volumes) ||
    input.volumes.length > 100 ||
    !Array.isArray(input.entries) ||
    input.entries.length > 10_000 ||
    !Array.isArray(input.warnings) ||
    input.warnings.length > 1_000
  ) {
    throw new Error("disk space report arrays are invalid");
  }
  const report: AgentDiskSpaceReport = {
    observedAt,
    volumes: input.volumes.map((raw, index) => {
      const volume = objectValue(raw, `disk space volumes[${index}]`);
      if (!Array.isArray(volume.roles) || !Array.isArray(volume.paths)) {
        throw new Error(`disk space volumes[${index}] arrays are invalid`);
      }
      const roles = volume.roles.map((role, roleIndex) => {
        if (
          typeof role !== "string" ||
          !DISK_SPACE_VOLUME_ROLES.includes(role as DiskSpaceVolumeRole)
        ) {
          throw new Error(
            `disk space volumes[${index}].roles[${roleIndex}] is invalid`,
          );
        }
        return role as DiskSpaceVolumeRole;
      });
      return {
        id: text(volume.id, `disk space volumes[${index}].id`),
        totalBytes: bytes(
          volume.totalBytes,
          `disk space volumes[${index}].totalBytes`,
        ),
        freeBytes: bytes(
          volume.freeBytes,
          `disk space volumes[${index}].freeBytes`,
        ),
        roles: [...new Set(roles)],
        paths: volume.paths.map((path, pathIndex) =>
          text(path, `disk space volumes[${index}].paths[${pathIndex}]`),
        ),
      };
    }),
    entries: input.entries.map((raw, index) => {
      const entry = objectValue(raw, `disk space entries[${index}]`);
      const kind = entry.kind;
      if (
        typeof kind !== "string" ||
        !["PROJECT", "PENDING", "SHARED_CACHE", "DEVICE_SUPPORT"].includes(kind)
      ) {
        throw new Error(`disk space entries[${index}].kind is invalid`);
      }
      const modifiedAt = text(
        entry.modifiedAt,
        `disk space entries[${index}].modifiedAt`,
      );
      if (Number.isNaN(Date.parse(modifiedAt))) {
        throw new Error(
          `disk space entries[${index}].modifiedAt must be an ISO date`,
        );
      }
      return {
        path: text(entry.path, `disk space entries[${index}].path`),
        rootPath: text(entry.rootPath, `disk space entries[${index}].rootPath`),
        name: text(entry.name, `disk space entries[${index}].name`),
        kind: kind as BuildDataScanEntryKind,
        workspacePath: nullableText(
          entry.workspacePath,
          `disk space entries[${index}].workspacePath`,
        ),
        modifiedAt,
        volumeId: text(entry.volumeId, `disk space entries[${index}].volumeId`),
      };
    }),
    warnings: input.warnings.map((warning, index) =>
      text(warning, `disk space warnings[${index}]`),
    ),
  };
  if (Date.parse(report.observedAt) > Date.now() + 5 * 60_000) {
    throw new Error("disk space report.observedAt cannot be in the future");
  }
  const volumeIds = new Set<string>();
  for (const volume of report.volumes) {
    if (volumeIds.has(volume.id)) {
      throw new Error(`Duplicate disk space volume id: ${volume.id}`);
    }
    if (volume.freeBytes > volume.totalBytes) {
      throw new Error(
        `disk space volume ${volume.id} free bytes exceed total bytes`,
      );
    }
    if (!volume.roles.length || !volume.paths.length) {
      throw new Error(
        `disk space volume ${volume.id} must include roles and paths`,
      );
    }
    volumeIds.add(volume.id);
  }
  const paths = new Set<string>();
  for (const entry of report.entries) {
    if (!volumeIds.has(entry.volumeId)) {
      throw new Error(
        `disk space entry ${entry.path} references an unknown volume`,
      );
    }
    if (paths.has(entry.path)) {
      throw new Error(`Duplicate disk space entry path: ${entry.path}`);
    }
    paths.add(entry.path);
  }
  return report;
}
