import { CCUSAGE_REPORT_JOB_KIND } from "@ai-development-environment/agent-contract";

import { runCloudflared } from "./cloudflared.js";
import { runCcusage } from "./ccusage.js";
import type { ProcessLog, ProcessResult } from "../process-runner.js";

export type AgentJobHandler = (
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
  onLog: (log: ProcessLog) => Promise<void>,
) => Promise<ProcessResult>;

export const handlers: Readonly<Record<string, AgentJobHandler>> = {
  "cloudflared.runTunnel": runCloudflared,
  [CCUSAGE_REPORT_JOB_KIND]: runCcusage,
};
