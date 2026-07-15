import { TUNNEL_NAME_REGEX } from "@ai-development-environment/agent-contract";

import {
  runProcess,
  type ProcessLog,
  type ProcessResult,
} from "../process-runner.js";

export type CloudflaredPayload = { tunnelName: string };

export function validateCloudflaredPayload(
  payload: unknown,
): CloudflaredPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Cloudflared payload must be an object");
  }
  const value = payload as Record<string, unknown>;
  if (
    typeof value.tunnelName !== "string" ||
    !TUNNEL_NAME_REGEX.test(value.tunnelName)
  ) {
    throw new Error("Invalid Cloudflared tunnel name");
  }
  if (Object.keys(value).some((key) => key !== "tunnelName")) {
    throw new Error("Cloudflared payload contains an unsupported field");
  }
  return { tunnelName: value.tunnelName };
}

export function runCloudflared(
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
  onLog: (log: ProcessLog) => Promise<void>,
): Promise<ProcessResult> {
  const { tunnelName } = validateCloudflaredPayload(payload);
  return runProcess({
    command: "cloudflared",
    args: ["tunnel", "run", tunnelName],
    timeoutMs,
    signal,
    onLog,
  });
}
