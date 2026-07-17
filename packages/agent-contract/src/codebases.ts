export const CODEBASE_BROWSE_JOB_KIND = "codebase.browse";
export const CODEBASE_INSPECT_JOB_KIND = "codebase.inspect";
export const CODEBASE_REFRESH_JOB_KIND = "codebase.refresh";
export const CODEBASE_FETCH_JOB_KIND = "codebase.fetch";
export const CODEBASE_GIT_INSPECT_JOB_KIND = "codebase.git.inspect";
export const CODEBASE_GIT_OPERATION_JOB_KIND = "codebase.git.operation";
export const CODEBASE_RECONCILE_EVENT_CAPABILITY =
  "codebase.reconcile.requested";

export const MAX_CODEBASE_GIT_BRANCHES = 1_000;
export const MAX_CODEBASE_STASHES = 200;
export const MAX_CODEBASE_STASH_PATCH_BYTES = 256 * 1024;

export const CODEBASE_GIT_OPERATIONS = [
  "SWITCH_BRANCH",
  "DELETE_BRANCH",
  "DELETE_REMOTE_BRANCH",
  "PULL_BRANCH",
  "APPLY_STASH",
  "DELETE_STASH",
] as const;

export type CodebaseGitOperation = (typeof CODEBASE_GIT_OPERATIONS)[number];

export const DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS = 30;
export const MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS = 10;
export const MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS = 3_600;

export const CODEBASE_JOB_KINDS = [
  CODEBASE_BROWSE_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
  CODEBASE_REFRESH_JOB_KIND,
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_GIT_INSPECT_JOB_KIND,
  CODEBASE_GIT_OPERATION_JOB_KIND,
] as const;

export type CodebaseSyncState =
  | "IN_SYNC"
  | "AHEAD"
  | "BEHIND"
  | "DIVERGED"
  | "NO_UPSTREAM"
  | "DETACHED"
  | "UNKNOWN";

export type CodebaseAvailability =
  "AVAILABLE" | "MISSING" | "NOT_REPOSITORY" | "ORIGIN_MISMATCH" | "ERROR";

export type CodebaseSnapshot = {
  folder: string;
  observedOrigin: string | null;
  canonicalOrigin: string | null;
  displayOrigin: string | null;
  branch: string | null;
  headSha: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  syncState: CodebaseSyncState;
  availability: CodebaseAvailability;
  error: string | null;
  checkedAt: string;
  fetchedAt: string | null;
  linkedWorktree: boolean;
};

export type CodebaseDirectoryListing = {
  path: string;
  parentPath: string | null;
  homePath: string;
  entries: Array<{ name: string; path: string; hidden: boolean }>;
  truncated: boolean;
};

export type CodebaseStatusReport = {
  codebaseId: string;
  snapshot: CodebaseSnapshot;
};

export type CodebaseGitBranch = {
  name: string;
  local: boolean;
  remote: boolean;
  current: boolean;
  checkedOutPath: string | null;
};

export type CodebaseStash = {
  oid: string;
  selector: string;
  message: string;
  createdAt: string;
};

export type CodebaseGitState = {
  dirty: boolean;
  branches: CodebaseGitBranch[];
  branchesTruncated: boolean;
  stashes: CodebaseStash[];
  stashesTruncated: boolean;
};

export type CodebaseStashDiff = {
  oid: string;
  patch: string;
  truncated: boolean;
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return stringValue(value, name);
}

function nullableCount(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer or null`);
  }
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function stashOid(value: unknown, name: string): string {
  const oid = stringValue(value, name);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(oid)) {
    throw new Error(`${name} must be a Git object ID`);
  }
  return oid.toLowerCase();
}

function dateString(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (Number.isNaN(new Date(result).valueOf())) {
    throw new Error(`${name} must be an ISO date`);
  }
  return result;
}

export function validCodebaseGitBranchName(value: string): boolean {
  if (!value || value.length > 255 || value === "@" || value.startsWith("-")) {
    return false;
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T;
}

export function parseCodebaseSnapshot(value: unknown): CodebaseSnapshot {
  const snapshot = objectValue(value, "codebase snapshot");
  const checkedAt = stringValue(snapshot.checkedAt, "snapshot.checkedAt");
  if (Number.isNaN(new Date(checkedAt).valueOf())) {
    throw new Error("snapshot.checkedAt must be an ISO date");
  }
  const fetchedAt = nullableString(snapshot.fetchedAt, "snapshot.fetchedAt");
  if (fetchedAt && Number.isNaN(new Date(fetchedAt).valueOf())) {
    throw new Error("snapshot.fetchedAt must be an ISO date or null");
  }
  if (typeof snapshot.linkedWorktree !== "boolean") {
    throw new Error("snapshot.linkedWorktree must be a boolean");
  }
  return {
    folder: stringValue(snapshot.folder, "snapshot.folder"),
    observedOrigin: nullableString(
      snapshot.observedOrigin,
      "snapshot.observedOrigin",
    ),
    canonicalOrigin: nullableString(
      snapshot.canonicalOrigin,
      "snapshot.canonicalOrigin",
    ),
    displayOrigin: nullableString(
      snapshot.displayOrigin,
      "snapshot.displayOrigin",
    ),
    branch: nullableString(snapshot.branch, "snapshot.branch"),
    headSha: nullableString(snapshot.headSha, "snapshot.headSha"),
    upstream: nullableString(snapshot.upstream, "snapshot.upstream"),
    ahead: nullableCount(snapshot.ahead, "snapshot.ahead"),
    behind: nullableCount(snapshot.behind, "snapshot.behind"),
    syncState: enumValue(
      snapshot.syncState,
      [
        "IN_SYNC",
        "AHEAD",
        "BEHIND",
        "DIVERGED",
        "NO_UPSTREAM",
        "DETACHED",
        "UNKNOWN",
      ] as const,
      "snapshot.syncState",
    ),
    availability: enumValue(
      snapshot.availability,
      [
        "AVAILABLE",
        "MISSING",
        "NOT_REPOSITORY",
        "ORIGIN_MISMATCH",
        "ERROR",
      ] as const,
      "snapshot.availability",
    ),
    error: nullableString(snapshot.error, "snapshot.error"),
    checkedAt,
    fetchedAt,
    linkedWorktree: snapshot.linkedWorktree,
  };
}

export function parseCodebaseDirectoryListing(
  value: unknown,
): CodebaseDirectoryListing {
  const listing = objectValue(value, "directory listing");
  if (!Array.isArray(listing.entries)) {
    throw new Error("directory listing.entries must be an array");
  }
  if (typeof listing.truncated !== "boolean") {
    throw new Error("directory listing.truncated must be a boolean");
  }
  return {
    path: stringValue(listing.path, "directory listing.path"),
    parentPath: nullableString(
      listing.parentPath,
      "directory listing.parentPath",
    ),
    homePath: stringValue(listing.homePath, "directory listing.homePath"),
    entries: listing.entries.map((entry, index) => {
      const item = objectValue(entry, `directory listing.entries[${index}]`);
      if (typeof item.hidden !== "boolean") {
        throw new Error(
          `directory listing.entries[${index}].hidden is invalid`,
        );
      }
      return {
        name: stringValue(
          item.name,
          `directory listing.entries[${index}].name`,
        ),
        path: stringValue(
          item.path,
          `directory listing.entries[${index}].path`,
        ),
        hidden: item.hidden,
      };
    }),
    truncated: listing.truncated,
  };
}

export type NormalizedGitOrigin = {
  canonicalOrigin: string;
  displayOrigin: string;
  sanitizedOrigin: string;
};

const CASE_INSENSITIVE_PATH_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
]);

function normalizedPath(host: string, value: string): string {
  let path = value
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\.git$/i, "");
  if (!path) throw new Error("Git origin must include a repository path");
  if (CASE_INSENSITIVE_PATH_HOSTS.has(host)) path = path.toLowerCase();
  return path;
}

export function normalizeGitOrigin(value: string): NormalizedGitOrigin {
  const origin = value.trim();
  if (!origin) throw new Error("Git origin is required");
  if (/^(?:file:|\/|\.|~)/i.test(origin)) {
    throw new Error("Git origin must be a remote host-based URL");
  }

  let host: string;
  let port = "";
  let path: string;
  let sanitizedOrigin: string;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) {
    const url = new URL(origin);
    if (url.protocol === "file:" || !url.hostname) {
      throw new Error("Git origin must be a remote host-based URL");
    }
    host = url.hostname.toLowerCase();
    const isDefaultPort =
      (url.protocol === "ssh:" && url.port === "22") ||
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "git:" && url.port === "9418");
    port = isDefaultPort ? "" : url.port;
    path = normalizedPath(host, url.pathname);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    sanitizedOrigin = url.toString().replace(/\/$/, "");
  } else {
    const scp = origin.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
    if (!scp?.[1] || !scp[2]) {
      throw new Error("Git origin must be a remote host-based URL");
    }
    host = scp[1].toLowerCase();
    path = normalizedPath(host, scp[2]);
    sanitizedOrigin = `${host}:${scp[2]}`;
  }

  const authority = port ? `${host}:${port}` : host;
  const canonicalOrigin = `${authority}/${path}`;
  return {
    canonicalOrigin,
    displayOrigin: canonicalOrigin,
    sanitizedOrigin,
  };
}

export function codebaseJobPayload(value: unknown): {
  folder: string;
  codebaseId?: string;
  expectedOrigin?: string;
  baseBranch?: string;
  keepBaseBranchUpToDate?: boolean;
} {
  const payload = objectValue(value, "codebase job payload");
  const allowed = new Set([
    "folder",
    "codebaseId",
    "expectedOrigin",
    "baseBranch",
    "keepBaseBranchUpToDate",
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected)
    throw new Error(`Unexpected codebase payload field: ${unexpected}`);
  return {
    folder: stringValue(payload.folder, "payload.folder"),
    ...(payload.codebaseId === undefined
      ? {}
      : { codebaseId: stringValue(payload.codebaseId, "payload.codebaseId") }),
    ...(payload.expectedOrigin === undefined
      ? {}
      : {
          expectedOrigin: stringValue(
            payload.expectedOrigin,
            "payload.expectedOrigin",
          ),
        }),
    ...(payload.baseBranch === undefined
      ? {}
      : {
          baseBranch: stringValue(payload.baseBranch, "payload.baseBranch"),
        }),
    ...(payload.keepBaseBranchUpToDate === undefined
      ? {}
      : {
          keepBaseBranchUpToDate: booleanValue(
            payload.keepBaseBranchUpToDate,
            "payload.keepBaseBranchUpToDate",
          ),
        }),
  };
}

export function codebaseBrowsePayload(value: unknown): {
  path: string | null;
} {
  const payload = objectValue(value, "codebase browse payload");
  const unexpected = Object.keys(payload).find((key) => key !== "path");
  if (unexpected)
    throw new Error(`Unexpected codebase browse field: ${unexpected}`);
  return { path: nullableString(payload.path, "payload.path") };
}

export function codebaseGitInspectPayload(value: unknown):
  | {
      action: "STATE";
      codebaseId: string;
      folder: string;
      expectedOrigin: string;
    }
  | {
      action: "STASH_DIFF";
      codebaseId: string;
      folder: string;
      expectedOrigin: string;
      stashOid: string;
    } {
  const payload = objectValue(value, "codebase Git inspect payload");
  const allowed = new Set([
    "action",
    "codebaseId",
    "folder",
    "expectedOrigin",
    "stashOid",
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(
      `Unexpected codebase Git inspect payload field: ${unexpected}`,
    );
  }
  if (payload.action !== "STATE" && payload.action !== "STASH_DIFF") {
    throw new Error("codebase Git inspect payload.action is invalid");
  }
  const common = {
    codebaseId: stringValue(
      payload.codebaseId,
      "codebase Git inspect payload.codebaseId",
    ),
    folder: stringValue(payload.folder, "codebase Git inspect payload.folder"),
    expectedOrigin: stringValue(
      payload.expectedOrigin,
      "codebase Git inspect payload.expectedOrigin",
    ),
  };
  if (payload.action === "STATE") {
    if (payload.stashOid !== undefined) {
      throw new Error("STATE inspection cannot include stashOid");
    }
    return { action: payload.action, ...common };
  }
  return {
    action: payload.action,
    ...common,
    stashOid: stashOid(
      payload.stashOid,
      "codebase Git inspect payload.stashOid",
    ),
  };
}

export function codebaseGitOperationPayload(value: unknown): {
  codebaseId: string;
  folder: string;
  expectedOrigin: string;
  defaultBranch: string | null;
  operation: CodebaseGitOperation;
  branch?: string;
  stashOid?: string;
  stashChanges?: boolean;
} {
  const payload = objectValue(value, "codebase Git operation payload");
  const allowed = new Set([
    "codebaseId",
    "folder",
    "expectedOrigin",
    "defaultBranch",
    "operation",
    "branch",
    "stashOid",
    "stashChanges",
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(
      `Unexpected codebase Git operation payload field: ${unexpected}`,
    );
  }
  const operation = enumValue(
    payload.operation,
    CODEBASE_GIT_OPERATIONS,
    "codebase Git operation payload.operation",
  );
  const common = {
    codebaseId: stringValue(
      payload.codebaseId,
      "codebase Git operation payload.codebaseId",
    ),
    folder: stringValue(
      payload.folder,
      "codebase Git operation payload.folder",
    ),
    expectedOrigin: stringValue(
      payload.expectedOrigin,
      "codebase Git operation payload.expectedOrigin",
    ),
    defaultBranch:
      payload.defaultBranch === undefined || payload.defaultBranch === null
        ? null
        : stringValue(
            payload.defaultBranch,
            "codebase Git operation payload.defaultBranch",
          ),
    operation,
  };
  const branchOperation = [
    "SWITCH_BRANCH",
    "DELETE_BRANCH",
    "DELETE_REMOTE_BRANCH",
    "PULL_BRANCH",
  ].includes(operation);
  if (branchOperation) {
    const branch = stringValue(
      payload.branch,
      "codebase Git operation payload.branch",
    );
    if (!validCodebaseGitBranchName(branch)) {
      throw new Error("Invalid Git branch name");
    }
    if (payload.stashOid !== undefined) {
      throw new Error(`${operation} cannot include stashOid`);
    }
    if (operation !== "SWITCH_BRANCH" && payload.stashChanges !== undefined) {
      throw new Error(`${operation} cannot include stashChanges`);
    }
    if (
      payload.stashChanges !== undefined &&
      typeof payload.stashChanges !== "boolean"
    ) {
      throw new Error("stashChanges must be a boolean");
    }
    return {
      ...common,
      branch,
      ...(operation === "SWITCH_BRANCH"
        ? { stashChanges: Boolean(payload.stashChanges) }
        : {}),
    };
  }
  if (payload.branch !== undefined || payload.stashChanges !== undefined) {
    throw new Error(`${operation} cannot include branch or stashChanges`);
  }
  return {
    ...common,
    stashOid: stashOid(
      payload.stashOid,
      "codebase Git operation payload.stashOid",
    ),
  };
}

export function parseCodebaseGitState(value: unknown): CodebaseGitState {
  const state = objectValue(value, "codebase Git state");
  if (!Array.isArray(state.branches)) {
    throw new Error("codebase Git state.branches must be an array");
  }
  if (!Array.isArray(state.stashes)) {
    throw new Error("codebase Git state.stashes must be an array");
  }
  if (
    state.branches.length > MAX_CODEBASE_GIT_BRANCHES ||
    state.stashes.length > MAX_CODEBASE_STASHES
  ) {
    throw new Error("codebase Git state exceeds its result limits");
  }
  return {
    dirty: booleanValue(state.dirty, "codebase Git state.dirty"),
    branches: state.branches.map((value, index) => {
      const branch = objectValue(
        value,
        `codebase Git state.branches[${index}]`,
      );
      const name = stringValue(
        branch.name,
        `codebase Git state.branches[${index}].name`,
      );
      if (!validCodebaseGitBranchName(name)) {
        throw new Error(
          `codebase Git state.branches[${index}].name is invalid`,
        );
      }
      return {
        name,
        local: booleanValue(
          branch.local,
          `codebase Git state.branches[${index}].local`,
        ),
        remote: booleanValue(
          branch.remote,
          `codebase Git state.branches[${index}].remote`,
        ),
        current: booleanValue(
          branch.current,
          `codebase Git state.branches[${index}].current`,
        ),
        checkedOutPath:
          branch.checkedOutPath === null
            ? null
            : stringValue(
                branch.checkedOutPath,
                `codebase Git state.branches[${index}].checkedOutPath`,
              ),
      };
    }),
    branchesTruncated: booleanValue(
      state.branchesTruncated,
      "codebase Git state.branchesTruncated",
    ),
    stashes: state.stashes.map((value, index) => {
      const stash = objectValue(value, `codebase Git state.stashes[${index}]`);
      return {
        oid: stashOid(stash.oid, `codebase Git state.stashes[${index}].oid`),
        selector: stringValue(
          stash.selector,
          `codebase Git state.stashes[${index}].selector`,
        ),
        message:
          typeof stash.message === "string"
            ? stash.message
            : (() => {
                throw new Error(
                  `codebase Git state.stashes[${index}].message must be a string`,
                );
              })(),
        createdAt: dateString(
          stash.createdAt,
          `codebase Git state.stashes[${index}].createdAt`,
        ),
      };
    }),
    stashesTruncated: booleanValue(
      state.stashesTruncated,
      "codebase Git state.stashesTruncated",
    ),
  };
}

export function parseCodebaseStashDiff(value: unknown): CodebaseStashDiff {
  const diff = objectValue(value, "codebase stash diff");
  if (typeof diff.patch !== "string") {
    throw new Error("codebase stash diff.patch must be a string");
  }
  if (
    new TextEncoder().encode(diff.patch).byteLength >
    MAX_CODEBASE_STASH_PATCH_BYTES
  ) {
    throw new Error("codebase stash diff.patch exceeds its result limit");
  }
  return {
    oid: stashOid(diff.oid, "codebase stash diff.oid"),
    patch: diff.patch,
    truncated: booleanValue(diff.truncated, "codebase stash diff.truncated"),
  };
}
