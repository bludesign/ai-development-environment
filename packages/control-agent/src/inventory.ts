import { statfsSync } from "node:fs";
import { arch, cpus, freemem, hostname, release, totalmem } from "node:os";

import { CCUSAGE_REPORT_JOB_KIND } from "@ai-development-environment/agent-contract";
import { BUILD_DATA_JOB_KINDS } from "@ai-development-environment/agent-contract/build-data";
import {
  CODEBASE_JOB_KINDS,
  CODEBASE_RECONCILE_EVENT_CAPABILITY,
} from "@ai-development-environment/agent-contract/codebases";
import { WORKTREE_JOB_KINDS } from "@ai-development-environment/agent-contract/worktrees";
import { SKILL_JOB_KINDS } from "@ai-development-environment/agent-contract/skills";
import { RUN_SESSION_READ_JOB_KIND } from "@ai-development-environment/agent-contract/runs";
import { IOS_BUILD_JOB_KINDS } from "@ai-development-environment/agent-contract/builds";
import { SIGNING_ASSET_JOB_KINDS } from "@ai-development-environment/agent-contract/signing-assets";

export const AGENT_VERSION = "0.1.0";
export const AGENT_CAPABILITIES = [
  "cloudflared.runTunnel",
  CCUSAGE_REPORT_JOB_KIND,
  ...BUILD_DATA_JOB_KINDS,
  ...CODEBASE_JOB_KINDS,
  CODEBASE_RECONCILE_EVENT_CAPABILITY,
  ...WORKTREE_JOB_KINDS,
  ...SKILL_JOB_KINDS,
  ...IOS_BUILD_JOB_KINDS,
  ...SIGNING_ASSET_JOB_KINDS,
  "runs.protocol.v1",
  "runs.provider.codex",
  "runs.provider.claude",
  "runs.provider.opencode",
  RUN_SESSION_READ_JOB_KIND,
];

export type AgentInventory = {
  hostname: string;
  version: string;
  osVersion: string;
  architecture: string;
  cpuModel: string;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  capabilities: string[];
  defaultBuildsDirectory?: string;
};

export function collectInventory(): AgentInventory {
  const disk = statfsSync("/", { bigint: true });
  return {
    hostname: hostname(),
    version: AGENT_VERSION,
    osVersion: `macOS ${release()}`,
    architecture: arch(),
    cpuModel: (cpus()[0]?.model ?? "Unknown").replace(/^Apple\s+/, ""),
    memoryTotalBytes: totalmem(),
    memoryFreeBytes: freemem(),
    diskTotalBytes: Number(disk.blocks * disk.bsize),
    diskFreeBytes: Number(disk.bavail * disk.bsize),
    capabilities: AGENT_CAPABILITIES,
  };
}
