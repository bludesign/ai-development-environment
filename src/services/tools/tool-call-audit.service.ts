import { createHash, randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  TOOL_CALL_AUDIT_CHANGED_TOPIC,
} from "@/services/agent-control";

import type { ToolCallAuditView } from "./types";

export type ToolInvocationContext = {
  caller: string;
  correlationId: string;
  source: "MCP" | "TOOLS_PAGE" | "WORKFLOW";
};

type AuditedToolCall = ToolInvocationContext & {
  arguments: unknown;
  groupId: string;
  toolName: string;
};

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      return item;
    }
    if (typeof item === "number")
      return Number.isFinite(item) ? item : String(item);
    if (typeof item === "bigint") return item.toString();
    if (Array.isArray(item)) return item.map(normalize);
    if (item instanceof Date) return item.toISOString();
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, child]) => child !== undefined)
          .sort(([first], [second]) => first.localeCompare(second))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return String(item);
  };
  return JSON.stringify(normalize(value));
}

export function hashToolArguments(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function auditView(value: {
  id: string;
  correlationId: string;
  caller: string;
  source: string;
  groupId: string;
  toolName: string;
  argumentsSha256: string;
  resultStatus: string;
  durationMs: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}): ToolCallAuditView {
  return {
    ...value,
    startedAt: value.startedAt.toISOString(),
    finishedAt: value.finishedAt?.toISOString() ?? null,
  };
}

export class ToolCallAuditService {
  async clear(): Promise<{ count: number }> {
    const prisma = await getPrismaClient();
    return prisma.toolCallAudit.deleteMany({
      where: { resultStatus: { not: "RUNNING" } },
    });
  }

  async execute<T>(
    input: AuditedToolCall,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prisma = await getPrismaClient();
    const id = randomUUID();
    const startedAt = new Date();
    await prisma.toolCallAudit.create({
      data: {
        id,
        correlationId: input.correlationId,
        caller: input.caller,
        source: input.source,
        groupId: input.groupId,
        toolName: input.toolName,
        argumentsSha256: hashToolArguments(input.arguments),
        resultStatus: "RUNNING",
        startedAt,
      },
    });
    try {
      const result = await operation();
      const finishedAt = new Date();
      await prisma.toolCallAudit.update({
        where: { id },
        data: {
          resultStatus: "SUCCEEDED",
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          finishedAt,
        },
      });
      agentEventBus.publish(TOOL_CALL_AUDIT_CHANGED_TOPIC, {
        toolCallAuditChanged: { id },
      });
      return result;
    } catch (error) {
      const finishedAt = new Date();
      await prisma.toolCallAudit
        .update({
          where: { id },
          data: {
            resultStatus: "FAILED",
            durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
            finishedAt,
          },
        })
        .catch(() => undefined);
      agentEventBus.publish(TOOL_CALL_AUDIT_CHANGED_TOPIC, {
        toolCallAuditChanged: { id },
      });
      throw error;
    }
  }

  async list(
    input: {
      first?: number;
      toolName?: string | null;
      resultStatus?: string | null;
    } = {},
  ): Promise<ToolCallAuditView[]> {
    const prisma = await getPrismaClient();
    const values = await prisma.toolCallAudit.findMany({
      where: {
        ...(input.toolName ? { toolName: input.toolName } : {}),
        ...(input.resultStatus ? { resultStatus: input.resultStatus } : {}),
      },
      orderBy: { startedAt: "desc" },
      take: Math.min(Math.max(input.first ?? 100, 1), 500),
    });
    return values.map(auditView);
  }

  async get(id: string): Promise<ToolCallAuditView | null> {
    const prisma = await getPrismaClient();
    const value = await prisma.toolCallAudit.findUnique({ where: { id } });
    return value ? auditView(value) : null;
  }
}
