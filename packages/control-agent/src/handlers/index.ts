import { runCloudflared } from "./cloudflared.js";
import type { ProcessLog, ProcessResult } from "../process-runner.js";

export type AgentJobHandler = (
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
  onLog: (log: ProcessLog) => Promise<void>,
) => Promise<ProcessResult>;

export const handlers: Readonly<Record<string, AgentJobHandler>> = {
  "cloudflared.runTunnel": runCloudflared,
};
