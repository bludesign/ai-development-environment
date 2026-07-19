import type { CodebaseSyncState } from "./codebases.ts";

export const WORKTREE_INSPECT_JOB_KIND = "worktree.inspect";
export const WORKTREE_OPERATION_JOB_KIND = "worktree.operation";
export const WORKTREE_WATCH_JOB_KIND = "worktree.watch";
export const WORKTREE_BRANCH_JOB_KIND = "worktree.branch";
export const WORKTREE_MOVE_PUSH_JOB_KIND = "worktree.move.push";
export const WORKTREE_MOVE_CHECKOUT_JOB_KIND = "worktree.move.checkout";
export const WORKTREE_DELETE_JOB_KIND = "worktree.delete";
export const WORKTREE_JOB_KINDS = [
  WORKTREE_INSPECT_JOB_KIND,
  WORKTREE_OPERATION_JOB_KIND,
  WORKTREE_WATCH_JOB_KIND,
  WORKTREE_BRANCH_JOB_KIND,
  WORKTREE_MOVE_PUSH_JOB_KIND,
  WORKTREE_MOVE_CHECKOUT_JOB_KIND,
  WORKTREE_DELETE_JOB_KIND,
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
export type WorktreeBranchAction = "CREATE" | "CHANGE";
export type WorktreeBranchJobMode = "NEW" | "EXISTING";
export const WORKTREE_PUSH_STATUSES = [
  "READY",
  "DIRTY",
  "DETACHED",
  "BEHIND",
  "DIVERGED",
  "UNKNOWN",
] as const;
export type WorktreePushStatus = (typeof WORKTREE_PUSH_STATUSES)[number];
export type WorktreeMoveDestinationMode = "NEW" | "EXISTING";

export type WorktreeActivityReport = {
  codebaseId: string;
  gitDirectory: string;
  branch?: string | null;
  headSha?: string | null;
  codeStateHash?: string | null;
  upstream?: string | null;
  ahead?: number | null;
  behind?: number | null;
  syncState?: CodebaseSyncState;
  baseAhead?: number | null;
  baseBehind?: number | null;
  hasStagedChanges?: boolean;
  hasUnstagedChanges?: boolean;
  pushStatus?: WorktreePushStatus;
  observedAt: string;
};

export type WorktreeInventoryItem = {
  gitDirectory: string;
  folder: string;
  relativePath: string;
  primary: boolean;
  branch: string | null;
  headSha: string | null;
  codeStateHash?: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  syncState: CodebaseSyncState;
  baseAhead: number | null;
  baseBehind: number | null;
  hasStagedChanges?: boolean;
  hasUnstagedChanges?: boolean;
  pushStatus?: WorktreePushStatus;
  availability: "AVAILABLE" | "MISSING" | "ERROR";
  error: string | null;
  checkedAt: string;
};

export type CodebaseWorktreeReport = {
  codebaseId: string;
  complete: boolean;
  defaultBranch: string | null;
  localBranches: string[];
  remoteBranches: string[];
  fetchedAt: string | null;
  fetchAttemptedAt: string | null;
  fetchError: string | null;
  worktrees: WorktreeInventoryItem[];
};

export function validGitBranchName(value: string): boolean {
  if (!value || value.length > 255 || value === "@" || value.startsWith("-"))
    return false;
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

function pushStatus(value: unknown, name: string): WorktreePushStatus {
  if (
    typeof value !== "string" ||
    !WORKTREE_PUSH_STATUSES.includes(value as WorktreePushStatus)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value as WorktreePushStatus;
}

function optionalPushStatus(
  value: unknown,
  name: string,
): WorktreePushStatus | undefined {
  if (value === undefined || value === null) return undefined;
  return pushStatus(value, name);
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
    codeStateHash: optionalNullableString(
      item.codeStateHash,
      `${name}.codeStateHash`,
    ),
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
    pushStatus:
      optionalPushStatus(item.pushStatus, `${name}.pushStatus`) ?? "UNKNOWN",
    availability: availability as WorktreeInventoryItem["availability"],
    error: nullableString(item.error, `${name}.error`),
    checkedAt: dateString(item.checkedAt, `${name}.checkedAt`),
  };
}

export function parseCodebaseWorktreeReport(
  value: unknown,
): CodebaseWorktreeReport {
  const report = objectValue(value, "worktree report");
  const localBranches =
    report.localBranches === undefined ? [] : report.localBranches;
  if (typeof report.complete !== "boolean") {
    throw new Error("worktree report.complete must be a boolean");
  }
  if (
    !Array.isArray(localBranches) ||
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
    localBranches: localBranches.map((branch, index) =>
      stringValue(branch, `worktree report.localBranches[${index}]`),
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

export function worktreeBranchJobPayload(value: unknown): {
  codebaseId: string;
  rootFolder: string;
  folder: string | null;
  gitDirectory: string | null;
  expectedOrigin: string;
  baseBranch: string;
  action: WorktreeBranchAction;
  mode: WorktreeBranchJobMode;
  candidates: string[];
  stashOnFailure: boolean;
} {
  const payload = objectValue(value, "worktree branch payload");
  const allowed = new Set([
    "codebaseId",
    "rootFolder",
    "folder",
    "gitDirectory",
    "expectedOrigin",
    "baseBranch",
    "action",
    "mode",
    "candidates",
    "stashOnFailure",
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`Unexpected worktree branch payload field: ${unexpected}`);
  }
  if (!(payload.action === "CREATE" || payload.action === "CHANGE")) {
    throw new Error("worktree branch payload.action is invalid");
  }
  if (!(payload.mode === "NEW" || payload.mode === "EXISTING")) {
    throw new Error("worktree branch payload.mode is invalid");
  }
  if (
    !Array.isArray(payload.candidates) ||
    payload.candidates.length < 1 ||
    payload.candidates.length > 100
  ) {
    throw new Error("worktree branch payload.candidates is invalid");
  }
  const candidates = payload.candidates.map((candidate, index) => {
    const branch = stringValue(
      candidate,
      `worktree branch payload.candidates[${index}]`,
    );
    if (!validGitBranchName(branch)) {
      throw new Error(`Invalid Git branch name: ${branch}`);
    }
    return branch;
  });
  if (new Set(candidates).size !== candidates.length) {
    throw new Error("worktree branch candidates must be unique");
  }
  const folder = nullableString(
    payload.folder,
    "worktree branch payload.folder",
  );
  const gitDirectory = nullableString(
    payload.gitDirectory,
    "worktree branch payload.gitDirectory",
  );
  if (payload.action === "CHANGE" && (!folder || !gitDirectory)) {
    throw new Error(
      "Changing a branch requires a worktree folder and Git directory",
    );
  }
  if (typeof payload.stashOnFailure !== "boolean") {
    throw new Error("worktree branch payload.stashOnFailure must be a boolean");
  }
  return {
    codebaseId: stringValue(
      payload.codebaseId,
      "worktree branch payload.codebaseId",
    ),
    rootFolder: stringValue(
      payload.rootFolder,
      "worktree branch payload.rootFolder",
    ),
    folder,
    gitDirectory,
    expectedOrigin: stringValue(
      payload.expectedOrigin,
      "worktree branch payload.expectedOrigin",
    ),
    baseBranch: stringValue(
      payload.baseBranch,
      "worktree branch payload.baseBranch",
    ),
    action: payload.action,
    mode: payload.mode,
    candidates,
    stashOnFailure: payload.stashOnFailure,
  };
}

export function worktreeMovePushJobPayload(value: unknown): {
  moveId: string;
  codebaseId: string;
  folder: string;
  gitDirectory: string;
  expectedOrigin: string;
  branch: string;
  expectedHeadSha: string;
} {
  const payload = objectValue(value, "worktree move push payload");
  const allowed = new Set([
    "moveId",
    "codebaseId",
    "folder",
    "gitDirectory",
    "expectedOrigin",
    "branch",
    "expectedHeadSha",
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(
      `Unexpected worktree move push payload field: ${unexpected}`,
    );
  }
  const branch = stringValue(
    payload.branch,
    "worktree move push payload.branch",
  );
  if (!validGitBranchName(branch)) throw new Error("Invalid Git branch name");
  return {
    moveId: stringValue(payload.moveId, "worktree move push payload.moveId"),
    codebaseId: stringValue(
      payload.codebaseId,
      "worktree move push payload.codebaseId",
    ),
    folder: stringValue(payload.folder, "worktree move push payload.folder"),
    gitDirectory: stringValue(
      payload.gitDirectory,
      "worktree move push payload.gitDirectory",
    ),
    expectedOrigin: stringValue(
      payload.expectedOrigin,
      "worktree move push payload.expectedOrigin",
    ),
    branch,
    expectedHeadSha: stringValue(
      payload.expectedHeadSha,
      "worktree move push payload.expectedHeadSha",
    ),
  };
}

export function worktreeMoveCheckoutJobPayload(value: unknown): {
  moveId: string;
  codebaseId: string;
  rootFolder: string;
  folder: string | null;
  gitDirectory: string | null;
  expectedOrigin: string;
  branch: string;
  expectedHeadSha: string;
  baseBranch: string;
  mode: WorktreeMoveDestinationMode;
  stashOnFailure: boolean;
} {
  const payload = objectValue(value, "worktree move checkout payload");
  const allowed = new Set([
    "moveId",
    "codebaseId",
    "rootFolder",
    "folder",
    "gitDirectory",
    "expectedOrigin",
    "branch",
    "expectedHeadSha",
    "baseBranch",
    "mode",
    "stashOnFailure",
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(
      `Unexpected worktree move checkout payload field: ${unexpected}`,
    );
  }
  if (!(payload.mode === "NEW" || payload.mode === "EXISTING")) {
    throw new Error("worktree move checkout payload.mode is invalid");
  }
  if (typeof payload.stashOnFailure !== "boolean") {
    throw new Error(
      "worktree move checkout payload.stashOnFailure must be a boolean",
    );
  }
  const folder = nullableString(
    payload.folder,
    "worktree move checkout payload.folder",
  );
  const gitDirectory = nullableString(
    payload.gitDirectory,
    "worktree move checkout payload.gitDirectory",
  );
  if (payload.mode === "EXISTING" && (!folder || !gitDirectory)) {
    throw new Error("An existing destination worktree is required");
  }
  const branch = stringValue(
    payload.branch,
    "worktree move checkout payload.branch",
  );
  if (!validGitBranchName(branch)) throw new Error("Invalid Git branch name");
  return {
    moveId: stringValue(
      payload.moveId,
      "worktree move checkout payload.moveId",
    ),
    codebaseId: stringValue(
      payload.codebaseId,
      "worktree move checkout payload.codebaseId",
    ),
    rootFolder: stringValue(
      payload.rootFolder,
      "worktree move checkout payload.rootFolder",
    ),
    folder,
    gitDirectory,
    expectedOrigin: stringValue(
      payload.expectedOrigin,
      "worktree move checkout payload.expectedOrigin",
    ),
    branch,
    expectedHeadSha: stringValue(
      payload.expectedHeadSha,
      "worktree move checkout payload.expectedHeadSha",
    ),
    baseBranch: stringValue(
      payload.baseBranch,
      "worktree move checkout payload.baseBranch",
    ),
    mode: payload.mode,
    stashOnFailure: payload.stashOnFailure,
  };
}

export function worktreeDeleteJobPayload(value: unknown): {
  moveId: string | null;
  codebaseId: string;
  rootFolder: string;
  folder: string;
  gitDirectory: string;
  expectedOrigin: string;
  branch: string | null;
  defaultBranch: string | null;
  deleteRemoteBranch: boolean;
  requireClean: boolean;
  expectedHeadSha: string | null;
} {
  const payload = objectValue(value, "worktree delete payload");
  const allowed = new Set([
    "moveId",
    "codebaseId",
    "rootFolder",
    "folder",
    "gitDirectory",
    "expectedOrigin",
    "branch",
    "defaultBranch",
    "deleteRemoteBranch",
    "requireClean",
    "expectedHeadSha",
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`Unexpected worktree delete payload field: ${unexpected}`);
  }
  if (
    typeof payload.deleteRemoteBranch !== "boolean" ||
    typeof payload.requireClean !== "boolean"
  ) {
    throw new Error("worktree delete payload flags must be booleans");
  }
  const branch = nullableString(
    payload.branch,
    "worktree delete payload.branch",
  );
  if (branch && !validGitBranchName(branch)) {
    throw new Error("Invalid Git branch name");
  }
  const expectedHeadSha = nullableString(
    payload.expectedHeadSha,
    "worktree delete payload.expectedHeadSha",
  );
  if (payload.requireClean && !expectedHeadSha) {
    throw new Error("Clean worktree deletion requires an expected HEAD");
  }
  return {
    moveId: nullableString(payload.moveId, "worktree delete payload.moveId"),
    codebaseId: stringValue(
      payload.codebaseId,
      "worktree delete payload.codebaseId",
    ),
    rootFolder: stringValue(
      payload.rootFolder,
      "worktree delete payload.rootFolder",
    ),
    folder: stringValue(payload.folder, "worktree delete payload.folder"),
    gitDirectory: stringValue(
      payload.gitDirectory,
      "worktree delete payload.gitDirectory",
    ),
    expectedOrigin: stringValue(
      payload.expectedOrigin,
      "worktree delete payload.expectedOrigin",
    ),
    branch,
    defaultBranch: nullableString(
      payload.defaultBranch,
      "worktree delete payload.defaultBranch",
    ),
    deleteRemoteBranch: payload.deleteRemoteBranch,
    requireClean: payload.requireClean,
    expectedHeadSha,
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
    "codeStateHash",
    "upstream",
    "ahead",
    "behind",
    "syncState",
    "baseAhead",
    "baseBehind",
    "hasStagedChanges",
    "hasUnstagedChanges",
    "pushStatus",
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
    codeStateHash: optionalNullableString(
      report.codeStateHash,
      "worktree activity report.codeStateHash",
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
    pushStatus: optionalPushStatus(
      report.pushStatus,
      "worktree activity report.pushStatus",
    ),
    observedAt: dateString(
      report.observedAt,
      "worktree activity report.observedAt",
    ),
  };
}
