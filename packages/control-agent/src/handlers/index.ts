import { CCUSAGE_REPORT_JOB_KIND } from "@ai-development-environment/agent-contract";
import {
  BUILD_DATA_DELETE_JOB_KIND,
  BUILD_DATA_SCAN_JOB_KIND,
  BUILD_DATA_SIZE_JOB_KIND,
} from "@ai-development-environment/agent-contract/build-data";
import {
  CODEBASE_BROWSE_JOB_KIND,
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_GIT_INSPECT_JOB_KIND,
  CODEBASE_GIT_OPERATION_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
  CODEBASE_REFRESH_JOB_KIND,
} from "@ai-development-environment/agent-contract/codebases";

import { runCloudflared } from "./cloudflared.js";
import { runCcusage } from "./ccusage.js";
import { deleteBuildData, scanBuildData, sizeBuildData } from "./build-data.js";
import type { ProcessLog, ProcessResult } from "../process-runner.js";
import {
  browseCodebaseDirectories,
  fetchCodebase,
  inspectCodebaseGit,
  inspectCodebaseFolder,
  operateCodebaseGit,
  refreshCodebase,
} from "./codebases.js";
import {
  WORKTREE_INSPECT_JOB_KIND,
  WORKTREE_BRANCH_JOB_KIND,
  WORKTREE_DELETE_JOB_KIND,
  WORKTREE_MOVE_CHECKOUT_JOB_KIND,
  WORKTREE_MOVE_PUSH_JOB_KIND,
  WORKTREE_OPERATION_JOB_KIND,
  WORKTREE_WATCH_JOB_KIND,
  type WorktreeActivityReport,
} from "@ai-development-environment/agent-contract/worktrees";
import {
  inspectWorktree,
  branchWorktree,
  deleteWorktree,
  checkoutMovedWorktree,
  pushMovedWorktree,
  operateWorktree,
  watchWorktree,
} from "./worktrees.js";

export type AgentJobHandlerContext = {
  reportWorktreeActivity: (input: WorktreeActivityReport) => Promise<unknown>;
};

export type AgentJobHandler = (
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
  onLog: (log: ProcessLog) => Promise<void>,
  context?: AgentJobHandlerContext,
) => Promise<ProcessResult>;

export const handlers: Readonly<Record<string, AgentJobHandler>> = {
  "cloudflared.runTunnel": runCloudflared,
  [CCUSAGE_REPORT_JOB_KIND]: runCcusage,
  [BUILD_DATA_SCAN_JOB_KIND]: scanBuildData,
  [BUILD_DATA_SIZE_JOB_KIND]: sizeBuildData,
  [BUILD_DATA_DELETE_JOB_KIND]: deleteBuildData,
  [CODEBASE_BROWSE_JOB_KIND]: browseCodebaseDirectories,
  [CODEBASE_INSPECT_JOB_KIND]: inspectCodebaseFolder,
  [CODEBASE_REFRESH_JOB_KIND]: refreshCodebase,
  [CODEBASE_FETCH_JOB_KIND]: fetchCodebase,
  [CODEBASE_GIT_INSPECT_JOB_KIND]: inspectCodebaseGit,
  [CODEBASE_GIT_OPERATION_JOB_KIND]: operateCodebaseGit,
  [WORKTREE_INSPECT_JOB_KIND]: inspectWorktree,
  [WORKTREE_BRANCH_JOB_KIND]: branchWorktree,
  [WORKTREE_MOVE_PUSH_JOB_KIND]: pushMovedWorktree,
  [WORKTREE_MOVE_CHECKOUT_JOB_KIND]: checkoutMovedWorktree,
  [WORKTREE_DELETE_JOB_KIND]: deleteWorktree,
  [WORKTREE_OPERATION_JOB_KIND]: operateWorktree,
  [WORKTREE_WATCH_JOB_KIND]: watchWorktree,
};
