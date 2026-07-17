import { CCUSAGE_REPORT_JOB_KIND } from "@ai-development-environment/agent-contract";
import {
  CODEBASE_BROWSE_JOB_KIND,
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_GIT_INSPECT_JOB_KIND,
  CODEBASE_GIT_OPERATION_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
  CODEBASE_REFRESH_JOB_KIND,
} from "@ai-development-environment/agent-contract/codebases";
import {
  WORKTREE_BRANCH_JOB_KIND,
  WORKTREE_DELETE_JOB_KIND,
  WORKTREE_INSPECT_JOB_KIND,
  WORKTREE_MOVE_CHECKOUT_JOB_KIND,
  WORKTREE_MOVE_PUSH_JOB_KIND,
  WORKTREE_OPERATION_JOB_KIND,
  WORKTREE_WATCH_JOB_KIND,
} from "@ai-development-environment/agent-contract/worktrees";

const worktreeContext = () => ({
  codebaseId: "",
  folder: "",
  gitDirectory: "",
  expectedOrigin: "",
  baseBranch: null,
});

export function samplePayloadForCapability(
  capability: string,
): Record<string, unknown> {
  switch (capability) {
    case "cloudflared.runTunnel":
      return { tunnelName: "" };
    case CCUSAGE_REPORT_JOB_KIND:
      return {};
    case CODEBASE_BROWSE_JOB_KIND:
      return { path: null };
    case CODEBASE_INSPECT_JOB_KIND:
      return { folder: "" };
    case CODEBASE_REFRESH_JOB_KIND:
      return { codebaseId: "", folder: "", expectedOrigin: "" };
    case CODEBASE_FETCH_JOB_KIND:
      return {
        codebaseId: "",
        folder: "",
        expectedOrigin: "",
        baseBranch: "",
        keepBaseBranchUpToDate: false,
      };
    case CODEBASE_GIT_INSPECT_JOB_KIND:
      return {
        action: "STATE",
        codebaseId: "",
        folder: "",
        expectedOrigin: "",
      };
    case CODEBASE_GIT_OPERATION_JOB_KIND:
      return {
        codebaseId: "",
        folder: "",
        expectedOrigin: "",
        defaultBranch: null,
        operation: "SWITCH_BRANCH",
        branch: "",
        stashChanges: false,
      };
    case WORKTREE_INSPECT_JOB_KIND:
      return worktreeContext();
    case WORKTREE_OPERATION_JOB_KIND:
      return { ...worktreeContext(), operation: "SYNC" };
    case WORKTREE_WATCH_JOB_KIND:
      return {
        ...worktreeContext(),
        action: "START",
        watchId: "",
      };
    case WORKTREE_BRANCH_JOB_KIND:
      return {
        codebaseId: "",
        rootFolder: "",
        folder: null,
        gitDirectory: null,
        expectedOrigin: "",
        baseBranch: "",
        action: "CREATE",
        mode: "NEW",
        candidates: [""],
        stashOnFailure: false,
      };
    case WORKTREE_MOVE_PUSH_JOB_KIND:
      return {
        moveId: "",
        codebaseId: "",
        folder: "",
        gitDirectory: "",
        expectedOrigin: "",
        branch: "",
        expectedHeadSha: "",
      };
    case WORKTREE_MOVE_CHECKOUT_JOB_KIND:
      return {
        moveId: "",
        codebaseId: "",
        rootFolder: "",
        folder: null,
        gitDirectory: null,
        expectedOrigin: "",
        branch: "",
        expectedHeadSha: "",
        baseBranch: "",
        mode: "NEW",
        stashOnFailure: false,
      };
    case WORKTREE_DELETE_JOB_KIND:
      return {
        moveId: null,
        codebaseId: "",
        rootFolder: "",
        folder: "",
        gitDirectory: "",
        expectedOrigin: "",
        branch: null,
        defaultBranch: null,
        deleteRemoteBranch: false,
        requireClean: false,
        expectedHeadSha: null,
      };
    default:
      return {};
  }
}
