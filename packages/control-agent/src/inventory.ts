import { arch, hostname, release } from "node:os";

import { CCUSAGE_REPORT_JOB_KIND } from "@ai-development-environment/agent-contract";
import {
  CODEBASE_JOB_KINDS,
  CODEBASE_RECONCILE_EVENT_CAPABILITY,
} from "@ai-development-environment/agent-contract/codebases";
import { WORKTREE_JOB_KINDS } from "@ai-development-environment/agent-contract/worktrees";

export const AGENT_VERSION = "0.1.0";
export const AGENT_CAPABILITIES = [
  "cloudflared.runTunnel",
  CCUSAGE_REPORT_JOB_KIND,
  ...CODEBASE_JOB_KINDS,
  CODEBASE_RECONCILE_EVENT_CAPABILITY,
  ...WORKTREE_JOB_KINDS,
];

export type AgentInventory = {
  hostname: string;
  version: string;
  osVersion: string;
  architecture: string;
  capabilities: string[];
};

export function collectInventory(): AgentInventory {
  return {
    hostname: hostname(),
    version: AGENT_VERSION,
    osVersion: `macOS ${release()}`,
    architecture: arch(),
    capabilities: AGENT_CAPABILITIES,
  };
}
