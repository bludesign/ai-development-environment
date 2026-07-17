import { CCUSAGE_REPORT_JOB_KIND } from "@ai-development-environment/agent-contract";
import {
  CODEBASE_BROWSE_JOB_KIND,
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
  CODEBASE_REFRESH_JOB_KIND,
} from "@ai-development-environment/agent-contract/codebases";

import { runCloudflared } from "./cloudflared.js";
import { runCcusage } from "./ccusage.js";
import type { ProcessLog, ProcessResult } from "../process-runner.js";
import {
  browseCodebaseDirectories,
  fetchCodebase,
  inspectCodebaseFolder,
  refreshCodebase,
} from "./codebases.js";
import {
  WORKTREE_INSPECT_JOB_KIND,
  WORKTREE_BRANCH_JOB_KIND,
  WORKTREE_OPERATION_JOB_KIND,
  WORKTREE_WATCH_JOB_KIND,
  type WorktreeActivityReport,
} from "@ai-development-environment/agent-contract/worktrees";
import {
  inspectWorktree,
  branchWorktree,
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
  [CODEBASE_BROWSE_JOB_KIND]: browseCodebaseDirectories,
  [CODEBASE_INSPECT_JOB_KIND]: inspectCodebaseFolder,
  [CODEBASE_REFRESH_JOB_KIND]: refreshCodebase,
  [CODEBASE_FETCH_JOB_KIND]: fetchCodebase,
  [WORKTREE_INSPECT_JOB_KIND]: inspectWorktree,
  [WORKTREE_BRANCH_JOB_KIND]: branchWorktree,
  [WORKTREE_OPERATION_JOB_KIND]: operateWorktree,
  [WORKTREE_WATCH_JOB_KIND]: watchWorktree,
};
