import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { hoursAgo, minutesAgo, secondsAgo } from "./time";

export async function seedTools(prisma: PrismaClient): Promise<void> {
  await prisma.externalMcpServer.create({
    data: {
      id: ids.externalMcpServers.linear,
      name: "Linear",
      url: `http://127.0.0.1:${process.env.MOCK_API_PORT || "4322"}/mcp`,
      transport: "STREAMABLE_HTTP",
      toolNamePrefix: "linear_",
    },
  });

  await prisma.mcpToolPreset.create({
    data: {
      id: ids.mcpPresets.core,
      name: "Core Tools",
      description:
        "Issue tracking and repository automation for day-to-day work.",
      iconKey: "wrench",
      enabledForPlans: true,
      enabledForSessions: true,
      externalTools: {
        create: [
          {
            serverId: ids.externalMcpServers.linear,
            toolName: "search_issues",
          },
        ],
      },
      tools: {
        create: [{ toolName: "get_codebases" }, { toolName: "get_agent_runs" }],
      },
    },
  });

  await prisma.toolCallAudit.createMany({
    data: [
      {
        id: "tool-audit-1",
        correlationId: "corr-1001",
        caller: "run:2001",
        source: "AGENT_RUN",
        groupId: "acme-web-app",
        toolName: "linear_update_issue",
        argumentsSha256: "sha256-args-0001",
        resultStatus: "SUCCESS",
        durationMs: 412,
        startedAt: minutesAgo(9),
        finishedAt: minutesAgo(9),
      },
      {
        id: "tool-audit-2",
        correlationId: "corr-1002",
        caller: "run:2001",
        source: "AGENT_RUN",
        groupId: "acme-web-app",
        toolName: "github_list_checks",
        argumentsSha256: "sha256-args-0002",
        resultStatus: "SUCCESS",
        durationMs: 233,
        startedAt: minutesAgo(8),
        finishedAt: minutesAgo(8),
      },
      {
        id: "tool-audit-3",
        correlationId: "corr-1003",
        caller: "workflow:4001",
        source: "WORKFLOW",
        groupId: "acme-api",
        toolName: "github_create_pull_request",
        argumentsSha256: "sha256-args-0003",
        resultStatus: "ERROR",
        durationMs: 1804,
        startedAt: secondsAgo(90),
        finishedAt: secondsAgo(88),
      },
      {
        id: "tool-audit-4",
        correlationId: "corr-1004",
        caller: "run:2002",
        source: "AGENT_RUN",
        groupId: "acme-api",
        toolName: "linear_create_issue",
        argumentsSha256: "sha256-args-0004",
        resultStatus: "SUCCESS",
        durationMs: 356,
        startedAt: hoursAgo(1),
        finishedAt: hoursAgo(1),
      },
    ],
  });
}
