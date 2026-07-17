export const BUILD_DATA_SCAN_JOB_KIND = "buildData.scan";
export const BUILD_DATA_SIZE_JOB_KIND = "buildData.size";
export const BUILD_DATA_DELETE_JOB_KIND = "buildData.delete";

export const BUILD_DATA_JOB_KINDS = [
  BUILD_DATA_SCAN_JOB_KIND,
  BUILD_DATA_SIZE_JOB_KIND,
  BUILD_DATA_DELETE_JOB_KIND,
] as const;

export const DERIVED_DATA_LOCATION_MODES = [
  "DEFAULT",
  "ABSOLUTE",
  "RELATIVE",
] as const;

export type DerivedDataLocationMode =
  (typeof DERIVED_DATA_LOCATION_MODES)[number];

export type BuildDataScanEntryKind = "PROJECT" | "PENDING" | "SHARED_CACHE";

export type BuildDataWorktreeRoot = {
  id: string;
  folder: string;
};

export type BuildDataTarget = {
  path: string;
  rootPath: string;
};

export type BuildDataScanEntry = BuildDataTarget & {
  name: string;
  kind: BuildDataScanEntryKind;
  workspacePath: string | null;
};

export type BuildDataScanResult = {
  entries: BuildDataScanEntry[];
  warnings: string[];
};

export type BuildDataSizeResult = {
  sizes: Array<{
    path: string;
    sizeBytes: number | null;
    error: string | null;
  }>;
};

export type BuildDataDeleteResult = {
  deleted: Array<{
    path: string;
    deleted: boolean;
    error: string | null;
  }>;
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return stringValue(value, name);
}

function exactKeys(
  value: JsonObject,
  allowed: readonly string[],
  name: string,
) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Unexpected ${name} field: ${unexpected}`);
}

export function parseDerivedDataLocationMode(
  value: unknown,
): DerivedDataLocationMode {
  if (
    typeof value !== "string" ||
    !DERIVED_DATA_LOCATION_MODES.includes(value as DerivedDataLocationMode)
  ) {
    throw new Error("Derived Data location mode is invalid");
  }
  return value as DerivedDataLocationMode;
}

function worktreeRoot(value: unknown, index: number): BuildDataWorktreeRoot {
  const root = objectValue(value, `build data worktrees[${index}]`);
  exactKeys(root, ["id", "folder"], "build data worktree");
  return {
    id: stringValue(root.id, `build data worktrees[${index}].id`),
    folder: stringValue(root.folder, `build data worktrees[${index}].folder`),
  };
}

function target(value: unknown, index: number): BuildDataTarget {
  const item = objectValue(value, `build data targets[${index}]`);
  exactKeys(item, ["path", "rootPath"], "build data target");
  return {
    path: stringValue(item.path, `build data targets[${index}].path`),
    rootPath: stringValue(
      item.rootPath,
      `build data targets[${index}].rootPath`,
    ),
  };
}

export function buildDataScanPayload(value: unknown): {
  mode: DerivedDataLocationMode;
  path: string | null;
  worktrees: BuildDataWorktreeRoot[];
} {
  const payload = objectValue(value, "build data scan payload");
  exactKeys(payload, ["mode", "path", "worktrees"], "build data scan payload");
  if (!Array.isArray(payload.worktrees)) {
    throw new Error("build data scan payload.worktrees must be an array");
  }
  const mode = parseDerivedDataLocationMode(payload.mode);
  const path = nullableString(payload.path, "build data scan payload.path");
  if (mode !== "DEFAULT" && !path) {
    throw new Error("Configured Derived Data modes require a path");
  }
  if (mode === "DEFAULT" && path !== null) {
    throw new Error("Default Derived Data mode does not accept a path");
  }
  return {
    mode,
    path,
    worktrees: payload.worktrees.map(worktreeRoot),
  };
}

export function buildDataTargetsPayload(value: unknown): {
  targets: BuildDataTarget[];
} {
  const payload = objectValue(value, "build data targets payload");
  exactKeys(payload, ["targets"], "build data targets payload");
  if (!Array.isArray(payload.targets) || payload.targets.length > 10_000) {
    throw new Error(
      "build data targets must be an array of at most 10,000 items",
    );
  }
  return { targets: payload.targets.map(target) };
}

export function parseBuildDataScanResult(value: unknown): BuildDataScanResult {
  const result = objectValue(value, "build data scan result");
  if (!Array.isArray(result.entries) || !Array.isArray(result.warnings)) {
    throw new Error("build data scan result arrays are invalid");
  }
  return {
    entries: result.entries.map((raw, index) => {
      const entry = objectValue(raw, `build data entries[${index}]`);
      const kind = entry.kind;
      if (
        !(["PROJECT", "PENDING", "SHARED_CACHE"] as unknown[]).includes(kind)
      ) {
        throw new Error(`build data entries[${index}].kind is invalid`);
      }
      return {
        path: stringValue(entry.path, `build data entries[${index}].path`),
        rootPath: stringValue(
          entry.rootPath,
          `build data entries[${index}].rootPath`,
        ),
        name: stringValue(entry.name, `build data entries[${index}].name`),
        kind: kind as BuildDataScanEntryKind,
        workspacePath: nullableString(
          entry.workspacePath,
          `build data entries[${index}].workspacePath`,
        ),
      };
    }),
    warnings: result.warnings.map((warning, index) =>
      stringValue(warning, `build data warnings[${index}]`),
    ),
  };
}

export function parseBuildDataSizeResult(value: unknown): BuildDataSizeResult {
  const result = objectValue(value, "build data size result");
  if (!Array.isArray(result.sizes)) {
    throw new Error("build data size result.sizes must be an array");
  }
  return {
    sizes: result.sizes.map((raw, index) => {
      const size = objectValue(raw, `build data sizes[${index}]`);
      if (
        size.sizeBytes !== null &&
        (typeof size.sizeBytes !== "number" ||
          !Number.isFinite(size.sizeBytes) ||
          size.sizeBytes < 0)
      ) {
        throw new Error(`build data sizes[${index}].sizeBytes is invalid`);
      }
      return {
        path: stringValue(size.path, `build data sizes[${index}].path`),
        sizeBytes: size.sizeBytes as number | null,
        error: nullableString(size.error, `build data sizes[${index}].error`),
      };
    }),
  };
}

export function parseBuildDataDeleteResult(
  value: unknown,
): BuildDataDeleteResult {
  const result = objectValue(value, "build data delete result");
  if (!Array.isArray(result.deleted)) {
    throw new Error("build data delete result.deleted must be an array");
  }
  return {
    deleted: result.deleted.map((raw, index) => {
      const deleted = objectValue(raw, `build data deleted[${index}]`);
      if (typeof deleted.deleted !== "boolean") {
        throw new Error(`build data deleted[${index}].deleted is invalid`);
      }
      return {
        path: stringValue(deleted.path, `build data deleted[${index}].path`),
        deleted: deleted.deleted,
        error: nullableString(
          deleted.error,
          `build data deleted[${index}].error`,
        ),
      };
    }),
  };
}
