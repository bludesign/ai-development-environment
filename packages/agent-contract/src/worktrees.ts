import type { CodebaseSyncState } from "./codebases.ts";

export const WORKTREE_INSPECT_JOB_KIND = "worktree.inspect";
export const WORKTREE_OPERATION_JOB_KIND = "worktree.operation";
export const WORKTREE_WATCH_JOB_KIND = "worktree.watch";
export const WORKTREE_JOB_KINDS = [
  WORKTREE_INSPECT_JOB_KIND,
  WORKTREE_OPERATION_JOB_KIND,
  WORKTREE_WATCH_JOB_KIND,
] as const;

export const DEFAULT_WORKTREE_FETCH_INTERVAL_SECONDS = 300;
export const MIN_WORKTREE_FETCH_INTERVAL_SECONDS = 60;
export const MAX_WORKTREE_FETCH_INTERVAL_SECONDS = 86_400;
export const DEFAULT_JIRA_BRANCH_REGEX = String.raw`\b([A-Z][A-Z0-9_]*-\d+)\b`;

export const WORKTREE_OPERATIONS = [
  "OPEN_EDITOR",
  "FORCE_PUSH",
  "SYNC",
  "PUSH",
  "RESET",
  "STASH_ALL",
  "STAGE_ALL",
  "UNSTAGE_ALL",
] as const;

export type WorktreeOperation = (typeof WORKTREE_OPERATIONS)[number];
export type WorktreeEditorVariant = "CODE" | "CODE_INSIDERS" | "NONE";
export type WorktreeWatchAction = "START" | "STOP";

export type WorktreeActivityReport = {
  codebaseId: string;
  gitDirectory: string;
  branch?: string | null;
  headSha?: string | null;
  upstream?: string | null;
  ahead?: number | null;
  behind?: number | null;
  syncState?: CodebaseSyncState;
  baseAhead?: number | null;
  baseBehind?: number | null;
  hasStagedChanges?: boolean;
  hasUnstagedChanges?: boolean;
  observedAt: string;
};

export type WorktreeInventoryItem = {
  gitDirectory: string;
  folder: string;
  relativePath: string;
  primary: boolean;
  branch: string | null;
  headSha: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  syncState: CodebaseSyncState;
  baseAhead: number | null;
  baseBehind: number | null;
  hasStagedChanges?: boolean;
  hasUnstagedChanges?: boolean;
  availability: "AVAILABLE" | "MISSING" | "ERROR";
  error: string | null;
  checkedAt: string;
};

export type CodebaseWorktreeReport = {
  codebaseId: string;
  complete: boolean;
  defaultBranch: string | null;
  remoteBranches: string[];
  fetchedAt: string | null;
  fetchAttemptedAt: string | null;
  fetchError: string | null;
  worktrees: WorktreeInventoryItem[];
};

export type WorktreeCommit = {
  sha: string;
  subject: string;
  authorName: string;
  authoredAt: string;
  additions: number;
  deletions: number;
};

export type WorktreeChange = {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  stagedAdditions: number | null;
  stagedDeletions: number | null;
  unstagedAdditions: number | null;
  unstagedDeletions: number | null;
};

export type WorktreeDetail = {
  commits: WorktreeCommit[];
  changes: WorktreeChange[];
  commitsTruncated: boolean;
  changesTruncated: boolean;
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
  if (value === null || value === undefined) return null;
  return stringValue(value, name);
}

function nullableCount(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer or null`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function optionalNullableString(
  value: unknown,
  name: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return stringValue(value, name);
}

function optionalNullableCount(
  value: unknown,
  name: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  return nullableCount(value, name);
}

function optionalSyncState(
  value: unknown,
  name: string,
): CodebaseSyncState | undefined {
  if (value === undefined) return undefined;
  return syncState(value, name);
}

function dateString(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (Number.isNaN(new Date(result).valueOf())) {
    throw new Error(`${name} must be an ISO date`);
  }
  return result;
}

function nullableDate(value: unknown, name: string): string | null {
  const result = nullableString(value, name);
  if (result && Number.isNaN(new Date(result).valueOf())) {
    throw new Error(`${name} must be an ISO date or null`);
  }
  return result;
}

function syncState(value: unknown, name: string): CodebaseSyncState {
  const states: CodebaseSyncState[] = [
    "IN_SYNC",
    "AHEAD",
    "BEHIND",
    "DIVERGED",
    "NO_UPSTREAM",
    "DETACHED",
    "UNKNOWN",
  ];
  if (
    typeof value !== "string" ||
    !states.includes(value as CodebaseSyncState)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value as CodebaseSyncState;
}

export function parseWorktreeInventoryItem(
  value: unknown,
  name = "worktree",
): WorktreeInventoryItem {
  const item = objectValue(value, name);
  if (typeof item.primary !== "boolean") {
    throw new Error(`${name}.primary must be a boolean`);
  }
  const availability = item.availability;
  if (
    !(["AVAILABLE", "MISSING", "ERROR"] as unknown[]).includes(availability)
  ) {
    throw new Error(`${name}.availability is invalid`);
  }
  return {
    gitDirectory: stringValue(item.gitDirectory, `${name}.gitDirectory`),
    folder: stringValue(item.folder, `${name}.folder`),
    relativePath: stringValue(item.relativePath, `${name}.relativePath`),
    primary: item.primary,
    branch: nullableString(item.branch, `${name}.branch`),
    headSha: nullableString(item.headSha, `${name}.headSha`),
    upstream: nullableString(item.upstream, `${name}.upstream`),
    ahead: nullableCount(item.ahead, `${name}.ahead`),
    behind: nullableCount(item.behind, `${name}.behind`),
    syncState: syncState(item.syncState, `${name}.syncState`),
    baseAhead: nullableCount(item.baseAhead, `${name}.baseAhead`),
    baseBehind: nullableCount(item.baseBehind, `${name}.baseBehind`),
    hasStagedChanges: optionalBoolean(
      item.hasStagedChanges,
      `${name}.hasStagedChanges`,
    ),
    hasUnstagedChanges: optionalBoolean(
      item.hasUnstagedChanges,
      `${name}.hasUnstagedChanges`,
    ),
    availability: availability as WorktreeInventoryItem["availability"],
    error: nullableString(item.error, `${name}.error`),
    checkedAt: dateString(item.checkedAt, `${name}.checkedAt`),
  };
}

export function parseCodebaseWorktreeReport(
  value: unknown,
): CodebaseWorktreeReport {
  const report = objectValue(value, "worktree report");
  if (typeof report.complete !== "boolean") {
    throw new Error("worktree report.complete must be a boolean");
  }
  if (
    !Array.isArray(report.remoteBranches) ||
    !Array.isArray(report.worktrees)
  ) {
    throw new Error("worktree report arrays are invalid");
  }
  return {
    codebaseId: stringValue(report.codebaseId, "worktree report.codebaseId"),
    complete: report.complete,
    defaultBranch: nullableString(
      report.defaultBranch,
      "worktree report.defaultBranch",
    ),
    remoteBranches: report.remoteBranches.map((branch, index) =>
      stringValue(branch, `worktree report.remoteBranches[${index}]`),
    ),
    fetchedAt: nullableDate(report.fetchedAt, "worktree report.fetchedAt"),
    fetchAttemptedAt: nullableDate(
      report.fetchAttemptedAt,
      "worktree report.fetchAttemptedAt",
    ),
    fetchError: nullableString(report.fetchError, "worktree report.fetchError"),
    worktrees: report.worktrees.map((item, index) =>
      parseWorktreeInventoryItem(item, `worktree report.worktrees[${index}]`),
    ),
  };
}

export function worktreeJobPayload(value: unknown): {
  codebaseId: string;
  folder: string;
  gitDirectory: string;
  expectedOrigin: string;
  baseBranch: string | null;
  operation?: WorktreeOperation;
  editorVariant?: WorktreeEditorVariant;
} {
  const payload = objectValue(value, "worktree payload");
  const allowed = new Set([
    "codebaseId",
    "folder",
    "gitDirectory",
    "expectedOrigin",
    "baseBranch",
    "operation",
    "editorVariant",
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected)
    throw new Error(`Unexpected worktree payload field: ${unexpected}`);
  const operation = payload.operation;
  if (
    operation !== undefined &&
    (typeof operation !== "string" ||
      !WORKTREE_OPERATIONS.includes(operation as WorktreeOperation))
  ) {
    throw new Error("worktree payload.operation is invalid");
  }
  const editorVariant = payload.editorVariant;
  if (
    editorVariant !== undefined &&
    !["CODE", "CODE_INSIDERS", "NONE"].includes(String(editorVariant))
  ) {
    throw new Error("worktree payload.editorVariant is invalid");
  }
  return {
    codebaseId: stringValue(payload.codebaseId, "worktree payload.codebaseId"),
    folder: stringValue(payload.folder, "worktree payload.folder"),
    gitDirectory: stringValue(
      payload.gitDirectory,
      "worktree payload.gitDirectory",
    ),
    expectedOrigin: stringValue(
      payload.expectedOrigin,
      "worktree payload.expectedOrigin",
    ),
    baseBranch: nullableString(
      payload.baseBranch,
      "worktree payload.baseBranch",
    ),
    ...(operation === undefined
      ? {}
      : { operation: operation as WorktreeOperation }),
    ...(editorVariant === undefined
      ? {}
      : { editorVariant: editorVariant as WorktreeEditorVariant }),
  };
}

export function worktreeWatchJobPayload(value: unknown): {
  codebaseId: string;
  folder: string;
  gitDirectory: string;
  expectedOrigin: string;
  baseBranch: string | null;
  action: WorktreeWatchAction;
  watchId: string;
} {
  const payload = objectValue(value, "worktree watch payload");
  const allowed = new Set([
    "codebaseId",
    "folder",
    "gitDirectory",
    "expectedOrigin",
    "baseBranch",
    "action",
    "watchId",
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`Unexpected worktree watch payload field: ${unexpected}`);
  }
  if (!(["START", "STOP"] as unknown[]).includes(payload.action)) {
    throw new Error("worktree watch payload.action is invalid");
  }
  return {
    codebaseId: stringValue(
      payload.codebaseId,
      "worktree watch payload.codebaseId",
    ),
    folder: stringValue(payload.folder, "worktree watch payload.folder"),
    gitDirectory: stringValue(
      payload.gitDirectory,
      "worktree watch payload.gitDirectory",
    ),
    expectedOrigin: stringValue(
      payload.expectedOrigin,
      "worktree watch payload.expectedOrigin",
    ),
    baseBranch: nullableString(
      payload.baseBranch,
      "worktree watch payload.baseBranch",
    ),
    action: payload.action as WorktreeWatchAction,
    watchId: stringValue(payload.watchId, "worktree watch payload.watchId"),
  };
}

export function parseWorktreeActivityReport(
  value: unknown,
): WorktreeActivityReport {
  const report = objectValue(value, "worktree activity report");
  const allowed = new Set([
    "codebaseId",
    "gitDirectory",
    "branch",
    "headSha",
    "upstream",
    "ahead",
    "behind",
    "syncState",
    "baseAhead",
    "baseBehind",
    "hasStagedChanges",
    "hasUnstagedChanges",
    "observedAt",
  ]);
  const unexpected = Object.keys(report).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`Unexpected worktree activity field: ${unexpected}`);
  }
  return {
    codebaseId: stringValue(
      report.codebaseId,
      "worktree activity report.codebaseId",
    ),
    gitDirectory: stringValue(
      report.gitDirectory,
      "worktree activity report.gitDirectory",
    ),
    branch: optionalNullableString(
      report.branch,
      "worktree activity report.branch",
    ),
    headSha: optionalNullableString(
      report.headSha,
      "worktree activity report.headSha",
    ),
    upstream: optionalNullableString(
      report.upstream,
      "worktree activity report.upstream",
    ),
    ahead: optionalNullableCount(
      report.ahead,
      "worktree activity report.ahead",
    ),
    behind: optionalNullableCount(
      report.behind,
      "worktree activity report.behind",
    ),
    syncState: optionalSyncState(
      report.syncState,
      "worktree activity report.syncState",
    ),
    baseAhead: optionalNullableCount(
      report.baseAhead,
      "worktree activity report.baseAhead",
    ),
    baseBehind: optionalNullableCount(
      report.baseBehind,
      "worktree activity report.baseBehind",
    ),
    hasStagedChanges: optionalBoolean(
      report.hasStagedChanges,
      "worktree activity report.hasStagedChanges",
    ),
    hasUnstagedChanges: optionalBoolean(
      report.hasUnstagedChanges,
      "worktree activity report.hasUnstagedChanges",
    ),
    observedAt: dateString(
      report.observedAt,
      "worktree activity report.observedAt",
    ),
  };
}
