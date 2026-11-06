import * as builds from "@ai-development-environment/agent-contract/builds";
import * as codebases from "@ai-development-environment/agent-contract/codebases";
import { COMMAND_RUN_JOB_KIND } from "@ai-development-environment/agent-contract/commands";
import * as workflows from "@ai-development-environment/agent-contract/workflows";
import * as worktrees from "@ai-development-environment/agent-contract/worktrees";

export type OperationLabelTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

type OperationJob = {
  kind: string;
  payload?: unknown;
  commandName?: string | null;
};

const operationLabels = {
  OPEN_EDITOR: "openEditor",
  FORCE_PUSH: "forcePush",
  SYNC: "sync",
  REBASE: "rebase",
  CANCEL_REBASE: "cancelRebase",
  PULL: "pull",
  PUSH: "push",
  RESET: "reset",
  CLEAR_LOCK: "clearLock",
  STASH_ALL: "stashAll",
  STAGE_ALL: "stageAll",
  UNSTAGE_ALL: "unstageAll",
} satisfies Record<worktrees.WorktreeOperation, string>;

const gitOperationLabels = {
  SWITCH_BRANCH: "switchBranch",
  DELETE_BRANCH: "deleteLocalBranch",
  DELETE_REMOTE_BRANCH: "deleteRemoteBranch",
  PULL_BRANCH: "pullBranch",
  APPLY_STASH: "applyStash",
  DELETE_STASH: "deleteStash",
} satisfies Record<
  worktrees.WorktreeGitOperation | codebases.CodebaseGitOperation,
  string
>;

const buildActionLabels = {
  BUILD: "build",
  TEST: "test",
  ANALYZE: "analyze",
  ARCHIVE: "archive",
  BUILD_FOR_TESTING: "buildForTesting",
  TEST_WITHOUT_BUILDING: "testWithoutBuilding",
} satisfies Record<builds.BuildAction, string>;

const preparationLabels = {
  INSPECT: "inspectPreparations",
  APPLY: "applyPreparations",
  UNDO: "undoPreparations",
} satisfies Record<worktrees.WorktreePreparationAction, string>;

const kindLabels: Record<string, string> = {
  [COMMAND_RUN_JOB_KIND]: "command",
  [worktrees.WORKTREE_OPERATION_JOB_KIND]: "worktreeOperation",
  [worktrees.WORKTREE_GIT_OPERATION_JOB_KIND]: "gitOperation",
  [worktrees.WORKTREE_COMMIT_JOB_KIND]: "commit",
  [worktrees.WORKTREE_AUTO_SYNC_JOB_KIND]: "autoSync",
  [worktrees.WORKTREE_POST_MERGE_SWITCH_JOB_KIND]: "switchBranch",
  [worktrees.WORKTREE_PREPARATION_JOB_KIND]: "preparations",
  [worktrees.WORKTREE_BRANCH_JOB_KIND]: "manageBranch",
  [worktrees.WORKTREE_MOVE_PUSH_JOB_KIND]: "movePush",
  [worktrees.WORKTREE_MOVE_CHECKOUT_JOB_KIND]: "moveCheckout",
  [worktrees.WORKTREE_DELETE_JOB_KIND]: "deleteWorktree",
  [worktrees.WORKTREE_INSPECT_JOB_KIND]: "inspectWorktree",
  [worktrees.WORKTREE_GIT_INSPECT_JOB_KIND]: "inspectGitState",
  [worktrees.WORKTREE_DIFF_JOB_KIND]: "inspectChanges",
  [worktrees.WORKTREE_DIFF_ASSET_JOB_KIND]: "loadChangedFile",
  [worktrees.WORKTREE_WATCH_JOB_KIND]: "fileWatcher",
  [worktrees.JIRA_BRANCH_GENERATE_JOB_KIND]: "generateBranchName",
  [workflows.WORKFLOW_TERMINAL_JOB_KIND]: "workflowTerminal",
  [workflows.WORKFLOW_GIT_CHECKPOINT_JOB_KIND]: "gitCheckpoint",
  [builds.IOS_BUILD_JOB_KIND]: "build",
  [builds.IOS_SOURCE_DISCOVER_JOB_KIND]: "findBuildSources",
  [builds.IOS_SOURCE_PARSE_JOB_KIND]: "readBuildConfiguration",
  [builds.IOS_DESTINATIONS_JOB_KIND]: "findBuildDestinations",
  [builds.IOS_RUN_DESTINATIONS_JOB_KIND]: "findRunDestinations",
  [builds.IOS_AGENT_RUN_DESTINATIONS_JOB_KIND]: "findRunDestinations",
  [builds.IOS_SIGNING_INSPECT_JOB_KIND]: "inspectSigningOptions",
  [builds.IOS_BUILD_DELETE_JOB_KIND]: "deleteBuild",
  [builds.IOS_ARTIFACT_DOWNLOAD_JOB_KIND]: "downloadBuildArtifact",
  [builds.IOS_ARTIFACT_TRANSFER_UPLOAD_JOB_KIND]: "uploadBuildArtifact",
  [builds.IOS_DEPLOY_JOB_KIND]: "deployBuild",
  [builds.IOS_REMOTE_DEPLOY_JOB_KIND]: "deployRemoteBuild",
  [builds.IOS_EXPORT_JOB_KIND]: "exportArchive",
  [builds.IOS_TEST_RESULTS_JOB_KIND]: "processTestResults",
  [builds.IOS_COVERAGE_REPORT_JOB_KIND]: "generateCoverageReport",
  // The coverage contract also exports Node-only path helpers.
  "coverage.import": "importCoverageReport",
  [codebases.CODEBASE_BROWSE_JOB_KIND]: "browseRepositories",
  [codebases.CODEBASE_INSPECT_JOB_KIND]: "inspectRepository",
  [codebases.CODEBASE_REFRESH_JOB_KIND]: "refreshRepository",
  [codebases.CODEBASE_FETCH_JOB_KIND]: "fetchChanges",
  [codebases.CODEBASE_CLONE_JOB_KIND]: "cloneRepository",
  [codebases.CODEBASE_CLONE_INSPECT_JOB_KIND]: "inspectClone",
  [codebases.CODEBASE_GIT_INSPECT_JOB_KIND]: "inspectRepositoryGitState",
  [codebases.CODEBASE_GIT_OPERATION_JOB_KIND]: "gitOperation",
  [codebases.CODEBASE_BRANCHES_DELETE_JOB_KIND]: "deleteBranches",
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Display only known payload fields; scripts and environments are never labels. */
export function worktreeOperationLabel(
  job: OperationJob,
  t: OperationLabelTranslator,
): string {
  const payload =
    job.payload &&
    typeof job.payload === "object" &&
    !Array.isArray(job.payload)
      ? (job.payload as Record<string, unknown>)
      : {};
  const fallback = () => {
    const action =
      text(payload.operation) ?? text(payload.action) ?? text(payload.phase);
    return action ? `${job.kind} (${action})` : job.kind;
  };
  const variant = (
    value: unknown,
    labels: Record<string, string>,
    defaultKey: string,
  ) => {
    const action = text(value);
    if (!action) return t(defaultKey);
    return Object.hasOwn(labels, action) ? t(labels[action]) : fallback();
  };

  switch (job.kind) {
    case COMMAND_RUN_JOB_KIND: {
      const name = text(job.commandName);
      return name ? t("namedCommand", { name }) : t("command");
    }
    case worktrees.WORKTREE_OPERATION_JOB_KIND:
      return variant(payload.operation, operationLabels, "worktreeOperation");
    case worktrees.WORKTREE_GIT_OPERATION_JOB_KIND:
    case codebases.CODEBASE_GIT_OPERATION_JOB_KIND:
      return variant(payload.operation, gitOperationLabels, "gitOperation");
    case worktrees.WORKTREE_AUTO_SYNC_JOB_KIND:
      return variant(
        payload.phase,
        { SYNC: "autoSync", FINALIZE: "finalizeSync" } satisfies Record<
          worktrees.WorktreeAutoSyncPhase,
          string
        >,
        "autoSync",
      );
    case worktrees.WORKTREE_PREPARATION_JOB_KIND:
      return variant(payload.action, preparationLabels, "preparations");
    case worktrees.WORKTREE_BRANCH_JOB_KIND:
      return variant(
        payload.action,
        { CREATE: "createWorktree", CHANGE: "changeBranch" } satisfies Record<
          worktrees.WorktreeBranchAction,
          string
        >,
        "manageBranch",
      );
    case worktrees.WORKTREE_WATCH_JOB_KIND:
      return variant(
        payload.action,
        { START: "startFileWatcher", STOP: "stopFileWatcher" } satisfies Record<
          worktrees.WorktreeWatchAction,
          string
        >,
        "fileWatcher",
      );
    case workflows.WORKFLOW_GIT_CHECKPOINT_JOB_KIND:
      return variant(
        payload.operation,
        {
          CAPTURE: "captureGitCheckpoint",
          COMPARE: "compareGitCheckpoint",
          RESTORE: "restoreGitCheckpoint",
        } satisfies Record<
          workflows.WorkflowGitCheckpointPayload["operation"],
          string
        >,
        "gitCheckpoint",
      );
    case builds.IOS_BUILD_JOB_KIND: {
      const label = variant(payload.action, buildActionLabels, "build");
      const scheme = text(payload.scheme);
      return scheme ? t("namedBuild", { action: label, scheme }) : label;
    }
    default:
      return Object.hasOwn(kindLabels, job.kind)
        ? t(kindLabels[job.kind])
        : fallback();
  }
}
