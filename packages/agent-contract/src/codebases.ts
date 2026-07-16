export const CODEBASE_BROWSE_JOB_KIND = "codebase.browse";
export const CODEBASE_INSPECT_JOB_KIND = "codebase.inspect";
export const CODEBASE_REFRESH_JOB_KIND = "codebase.refresh";
export const CODEBASE_FETCH_JOB_KIND = "codebase.fetch";

export const CODEBASE_JOB_KINDS = [
  CODEBASE_BROWSE_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
  CODEBASE_REFRESH_JOB_KIND,
  CODEBASE_FETCH_JOB_KIND,
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
} {
  const payload = objectValue(value, "codebase job payload");
  const allowed = new Set(["folder", "codebaseId", "expectedOrigin"]);
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
