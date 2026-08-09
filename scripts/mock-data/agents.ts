import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo, fromNow, hoursAgo, minutesAgo } from "./time";

const GIB = 1024 * 1024 * 1024;

/** Large heartbeat interval keeps every seeded agent inside its ONLINE window for hours. */
const HEARTBEAT_INTERVAL_SECONDS = 86_400;

/**
 * A disk report goes STALE two poll intervals (120s) after it was taken, but the seed runs once
 * and the database is then read for the length of a whole capture run — agents whose rings start
 * out CRITICAL were turning grey partway through it. Dating the reports an hour ahead means the
 * clock never catches up. The monitor renders `lastReportedAt` as a plain time of day rather
 * than a relative age, so the lead is not visible in the captures.
 */
const REPORT_LEAD_MS = 300 * 60_000;
const reportedAt = (secondsApart: number): Date =>
  fromNow(REPORT_LEAD_MS - secondsApart * 1_000);

/**
 * Deliberately omits the live git-inspection capabilities (`codebase.git.inspect`,
 * `worktree.git.inspect`). Pages that see them on an ONLINE agent dispatch an inspection job
 * and await its result; with no real agent connected that promise never settles and the page
 * is stuck on its loading spinner. Without them the pages fall back to the persisted branch
 * and status data seeded below, which is what the screenshots should show.
 */
const AGENT_CAPABILITIES = [
  "cli.health",
  "command.run",
  "ccusage.report",
  "buildData.scan",
  "buildData.size",
  "buildData.delete",
  "codebase.browse",
  "codebase.inspect",
  "codebase.refresh",
  "codebase.fetch",
  "codebase.git.operation",
  "codebase.reconcile.requested",
  "worktree.inspect",
  "worktree.operation",
  "worktree.diff.inspect",
  "skills.scan",
  "skills.read",
  "skills.apply",
  "ios.build",
  "ios.build.delete",
  "signing.assets.scan",
  "runs.protocol.v1",
  "runs.provider.codex",
  "runs.provider.claude",
  "runs.provider.opencode",
  "runs.session.read",
  "workflow.terminal.run",
  "workflow.git.checkpoint",
];

const healthResult = (failClaude = false) => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  checks: [
    [
      "builtin-acli-jira",
      "Atlassian Jira",
      "acli jira auth status",
      0,
      "Authenticated to acme.atlassian.net",
    ],
    [
      "builtin-acli",
      "Atlassian CLI",
      "acli auth status",
      0,
      "Authentication is valid",
    ],
    [
      "builtin-claude",
      "Claude",
      "claude auth status",
      failClaude ? 1 : 0,
      failClaude ? "Authentication expired" : "Authenticated with Claude",
    ],
    [
      "builtin-codex",
      "Codex",
      "codex login status",
      0,
      "Logged in using ChatGPT",
    ],
    ["builtin-opencode", "OpenCode", "opencode auth list", 0, "OpenAI oauth"],
    [
      "builtin-xcode",
      "Xcode",
      "xcodebuild -version",
      0,
      "Xcode 26.0\nBuild version 17A100",
    ],
    [
      "builtin-github",
      "GitHub",
      "gh auth status",
      0,
      "Logged in to github.com",
    ],
    [
      "builtin-gitlab",
      "GitLab",
      "glab auth status",
      0,
      "Logged in to gitlab.com",
    ],
    ["mock-node-version", "Node.js", "node --version", 0, "v24.18.0"],
  ].map(([id, name, command, exitCode, output]) => ({
    id,
    name,
    command,
    builtIn: String(id).startsWith("builtin-"),
    exitCode,
    stdout: exitCode === 0 ? output : "",
    stderr: exitCode === 0 ? "" : output,
    durationMs: 180,
    checkedAt: hoursAgo(1).toISOString(),
    timedOut: false,
    launchError: null,
    outputTruncated: false,
  })),
});

function diskSpaceState(rootFolder: string, volumeId: string) {
  const derivedRoot = `${rootFolder}/Library/Developer/Xcode/DerivedData`;
  return {
    volumes: [
      {
        id: "disk1s1",
        capacityId: "system-volume",
        totalBytes: 2048 * GIB,
        freeBytes: 812 * GIB,
        roles: ["MAIN", "BASE_REPO"],
        paths: [rootFolder],
      },
      {
        id: volumeId,
        capacityId: "system-volume",
        totalBytes: 2048 * GIB,
        freeBytes: 812 * GIB,
        roles: ["DERIVED_DATA"],
        paths: [derivedRoot],
      },
    ],
    entries: [
      {
        path: `${derivedRoot}/AcmeWebApp-abcdefghijklmnop`,
        rootPath: derivedRoot,
        name: "AcmeWebApp-abcdefghijklmnop",
        kind: "PROJECT",
        workspacePath: `${rootFolder}/acme/web-app`,
        modifiedAt: hoursAgo(4).toISOString(),
        volumeId,
      },
      {
        path: `${derivedRoot}/AcmeiOSApp-qrstuvwxyz012345`,
        rootPath: derivedRoot,
        name: "AcmeiOSApp-qrstuvwxyz012345",
        kind: "PROJECT",
        workspacePath: `${rootFolder}/acme/ios-app`,
        modifiedAt: hoursAgo(9).toISOString(),
        volumeId,
      },
      {
        path: `${derivedRoot}/ModuleCache.noindex`,
        rootPath: derivedRoot,
        name: "ModuleCache.noindex",
        kind: "SHARED_CACHE",
        workspacePath: null,
        modifiedAt: daysAgo(1).toISOString(),
        volumeId,
      },
    ],
    warnings: [],
  };
}

export async function seedAgents(prisma: PrismaClient): Promise<void> {
  await prisma.agent.create({
    data: {
      id: ids.agents.studio,
      name: "Studio Mac",
      hostname: "studio-mac.local",
      version: "0.1.0",
      osVersion: "macOS 15.5",
      architecture: "arm64",
      cpuModel: "M3 Ultra",
      memoryTotalBytes: 128 * GIB,
      memoryFreeBytes: 46 * GIB,
      diskTotalBytes: 2048 * GIB,
      diskFreeBytes: 812 * GIB,
      capabilitiesJson: JSON.stringify(AGENT_CAPABILITIES),
      secretHash: "mock-secret-hash-studio-mac",
      baseRepoDirectory: "/Users/acme/Repositories",
      derivedDataLocationMode: "DEFAULT",
      defaultBuildsDirectory: "/Users/acme/Repositories/Builds",
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      ipAddress: "192.168.1.24",
      lastSeenAt: minutesAgo(1),
      createdAt: daysAgo(45),
    },
  });

  await prisma.agent.create({
    data: {
      id: ids.agents.build,
      name: "Build Mac",
      hostname: "build-mac.local",
      version: "0.1.0",
      osVersion: "macOS 15.5",
      architecture: "arm64",
      cpuModel: "M2 Pro",
      memoryTotalBytes: 32 * GIB,
      memoryFreeBytes: 11 * GIB,
      diskTotalBytes: 1024 * GIB,
      diskFreeBytes: 233 * GIB,
      capabilitiesJson: JSON.stringify(AGENT_CAPABILITIES),
      secretHash: "mock-secret-hash-build-mac",
      baseRepoDirectory: "/Users/acme/Repositories",
      derivedDataLocationMode: "DEFAULT",
      defaultBuildsDirectory: "/Users/acme/Repositories/Builds",
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      ipAddress: "192.168.1.31",
      lastSeenAt: minutesAgo(2),
      createdAt: daysAgo(30),
    },
  });

  await prisma.agent.create({
    data: {
      id: ids.agents.ci,
      name: "CI Runner",
      hostname: "ci-runner.local",
      version: "0.1.0",
      osVersion: "macOS 14.6",
      architecture: "arm64",
      cpuModel: "M1 Max",
      memoryTotalBytes: 64 * GIB,
      memoryFreeBytes: 4 * GIB,
      diskTotalBytes: 1024 * GIB,
      diskFreeBytes: 61 * GIB,
      capabilitiesJson: JSON.stringify(AGENT_CAPABILITIES),
      secretHash: "mock-secret-hash-ci-runner",
      derivedDataLocationMode: "DEFAULT",
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      ipAddress: "192.168.1.44",
      // Every seeded agent is connected: pages gated on an ONLINE agent (usage collection,
      // command targets, capability invocation) show their populated state in the captures
      // instead of an offline fallback.
      lastSeenAt: minutesAgo(3),
      createdAt: daysAgo(20),
    },
  });

  const studioDisk = diskSpaceState("/Users/acme", "disk3s5");
  await prisma.agentDiskSpaceState.create({
    data: {
      agentId: ids.agents.studio,
      enabled: true,
      volumesJson: JSON.stringify(studioDisk.volumes),
      entriesJson: JSON.stringify(studioDisk.entries),
      warningsJson: JSON.stringify(studioDisk.warnings),
      lastReportedAt: reportedAt(20),
    },
  });

  const buildDisk = diskSpaceState("/Users/acme", "disk2s4");
  await prisma.agentDiskSpaceState.create({
    data: {
      agentId: ids.agents.build,
      enabled: true,
      automaticPressureMode: true,
      volumesJson: JSON.stringify([
        {
          ...buildDisk.volumes[1],
          freeBytes: 8 * GIB,
        },
      ]),
      entriesJson: JSON.stringify(buildDisk.entries),
      warningsJson: JSON.stringify([
        "Derived Data volume is below the pressure threshold.",
      ]),
      lastReportedAt: reportedAt(45),
    },
  });

  const ciDisk = diskSpaceState("/Users/ci", "disk4s2");
  await prisma.agentDiskSpaceState.create({
    data: {
      agentId: ids.agents.ci,
      enabled: true,
      volumesJson: JSON.stringify(
        ciDisk.volumes.map((volume) => ({
          ...volume,
          totalBytes: 1024 * GIB,
          freeBytes: 61 * GIB,
        })),
      ),
      entriesJson: JSON.stringify(ciDisk.entries),
      warningsJson: JSON.stringify(ciDisk.warnings),
      lastReportedAt: reportedAt(30),
    },
  });

  await prisma.agentJob.createMany({
    data: [
      {
        id: ids.jobs.codebaseRefresh,
        agentId: ids.agents.studio,
        kind: "codebase.refresh",
        payloadJson: JSON.stringify({ codebaseId: ids.codebases.web }),
        status: "SUCCEEDED",
        idempotencyKey: "job-codebase-refresh-1",
        resultJson: JSON.stringify({ branch: "main", ahead: 0, behind: 0 }),
        timeoutSeconds: 120,
        createdAt: minutesAgo(14),
        startedAt: minutesAgo(14),
        finishedAt: minutesAgo(13),
      },
      {
        id: "job-command-run-1",
        agentId: ids.agents.studio,
        kind: "command.run",
        payloadJson: JSON.stringify({ script: "npm test" }),
        status: "SUCCEEDED",
        idempotencyKey: "job-command-run-1",
        resultJson: JSON.stringify({ exitCode: 0 }),
        timeoutSeconds: 600,
        createdAt: hoursAgo(2),
        startedAt: hoursAgo(2),
        finishedAt: hoursAgo(2),
      },
      {
        id: "job-ccusage-1",
        agentId: ids.agents.build,
        kind: "ccusage.report",
        payloadJson: JSON.stringify({ range: "30d" }),
        status: "SUCCEEDED",
        idempotencyKey: "job-ccusage-1",
        resultJson: JSON.stringify({ days: 30 }),
        timeoutSeconds: 120,
        createdAt: hoursAgo(6),
        startedAt: hoursAgo(6),
        finishedAt: hoursAgo(6),
      },
      {
        id: "job-builddata-scan-1",
        agentId: ids.agents.build,
        kind: "buildData.scan",
        payloadJson: JSON.stringify({}),
        status: "FAILED",
        idempotencyKey: "job-builddata-scan-1",
        error: "Timed out while scanning Derived Data",
        timeoutSeconds: 120,
        createdAt: hoursAgo(8),
        startedAt: hoursAgo(8),
        finishedAt: hoursAgo(8),
      },
      {
        id: "job-cli-health-studio",
        agentId: ids.agents.studio,
        kind: "cli.health",
        payloadJson: JSON.stringify({ checks: [] }),
        status: "SUCCEEDED",
        idempotencyKey: "mock-cli-health-studio",
        resultJson: JSON.stringify(healthResult(false)),
        timeoutSeconds: 600,
        visibility: "SYSTEM",
        createdAt: hoursAgo(1),
        startedAt: hoursAgo(1),
        finishedAt: hoursAgo(1),
      },
      {
        id: "job-cli-health-build",
        agentId: ids.agents.build,
        kind: "cli.health",
        payloadJson: JSON.stringify({ checks: [] }),
        status: "SUCCEEDED",
        idempotencyKey: "mock-cli-health-build",
        resultJson: JSON.stringify(healthResult(true)),
        timeoutSeconds: 600,
        visibility: "SYSTEM",
        createdAt: hoursAgo(2),
        startedAt: hoursAgo(2),
        finishedAt: hoursAgo(2),
      },
    ],
  });

  await prisma.agentJobLog.createMany({
    data: [
      {
        id: "job-log-1",
        jobId: ids.jobs.codebaseRefresh,
        sequence: 1,
        stream: "SYSTEM",
        message: "Starting codebase refresh for acme/web-app",
        createdAt: minutesAgo(14),
      },
      {
        id: "job-log-2",
        jobId: ids.jobs.codebaseRefresh,
        sequence: 2,
        stream: "STDOUT",
        message: "Fetching origin… up to date with main",
        createdAt: minutesAgo(14),
      },
      {
        id: "job-log-3",
        jobId: ids.jobs.codebaseRefresh,
        sequence: 3,
        stream: "SYSTEM",
        message: "Refresh completed successfully",
        createdAt: minutesAgo(13),
      },
    ],
  });

  await prisma.agentAuditEvent.createMany({
    data: [
      {
        id: "audit-1",
        agentId: ids.agents.studio,
        action: "agent.enrolled",
        ipAddress: "192.168.1.24",
        createdAt: daysAgo(45),
      },
      {
        id: "audit-2",
        agentId: ids.agents.studio,
        action: "agent.configuration.updated",
        details: JSON.stringify({
          baseRepoDirectory: "/Users/acme/Repositories",
        }),
        ipAddress: "192.168.1.24",
        createdAt: daysAgo(44),
      },
      {
        id: "audit-3",
        agentId: ids.agents.build,
        action: "agent.enrolled",
        ipAddress: "192.168.1.31",
        createdAt: daysAgo(30),
      },
    ],
  });

  await prisma.runProviderSync.createMany({
    data: [
      {
        id: "provider-sync-studio-claude",
        agentId: ids.agents.studio,
        provider: "CLAUDE",
        status: "IDLE",
        importedCount: 18,
        unmatchedCount: 2,
        lastCompletedAt: minutesAgo(30),
      },
      {
        id: "provider-sync-studio-codex",
        agentId: ids.agents.studio,
        provider: "CODEX",
        status: "IDLE",
        importedCount: 11,
        unmatchedCount: 0,
        lastCompletedAt: hoursAgo(1),
      },
    ],
  });
}
