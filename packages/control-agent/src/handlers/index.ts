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

export type AgentJobHandler = (
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
  onLog: (log: ProcessLog) => Promise<void>,
) => Promise<ProcessResult>;

export const handlers: Readonly<Record<string, AgentJobHandler>> = {
  "cloudflared.runTunnel": runCloudflared,
  [CCUSAGE_REPORT_JOB_KIND]: runCcusage,
  [CODEBASE_BROWSE_JOB_KIND]: browseCodebaseDirectories,
  [CODEBASE_INSPECT_JOB_KIND]: inspectCodebaseFolder,
  [CODEBASE_REFRESH_JOB_KIND]: refreshCodebase,
  [CODEBASE_FETCH_JOB_KIND]: fetchCodebase,
};
