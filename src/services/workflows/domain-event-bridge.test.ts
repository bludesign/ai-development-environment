import { describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  agentEventBus,
  ACTION_CENTER_CHANGED_TOPIC,
  APP_NOTIFICATIONS_CHANGED_TOPIC,
  BUILD_SCRIPTS_CHANGED_TOPIC,
  CLI_HEALTH_CHANGED_TOPIC,
  COMMANDS_CHANGED_TOPIC,
  CRASH_REPORTS_CHANGED_TOPIC,
  DSYMS_CHANGED_TOPIC,
  REPOSITORY_TRANSFER_CHANGED_TOPIC,
  SKILLS_CHANGED_TOPIC,
  SSE_ENDPOINTS_CHANGED_TOPIC,
  SSE_STORAGE_CHANGED_TOPIC,
  TAILSCALE_SERVE_CHANGED_TOPIC,
  TELEMETRY_CHANGED_TOPIC,
} from "@/services/agent-control";
import { APPS_CHANGED_TOPIC } from "@/services/apps/apps.service";
import { DomainWorkflowEventBridge } from "./domain-event-bridge";

describe("domain workflow events", () => {
  test("preserves failed dSYM-upload and health-job identity before an indexed dSYM or successful check exists", async () => {
    const now = new Date("2026-10-28T12:00:00Z");
    const findUnique = vi.fn().mockResolvedValue({
      id: "upload",
      status: "FAILED",
      error: "invalid archive",
      updatedAt: now,
    });
    getPrismaClient.mockResolvedValue({ dsymUpload: { findUnique } });
    const record = vi.fn().mockResolvedValue({});
    const bridge = new DomainWorkflowEventBridge({ record } as never, {
      cliHealth: {
        statusForAgent: vi.fn().mockResolvedValue({
          name: "Agent",
          overall: "HEALTHY",
          results: [{ state: "HEALTHY" }],
          activeJobId: null,
          lastCheckedAt: null,
        }),
      } as never,
    });
    bridge.start();
    try {
      agentEventBus.publish(DSYMS_CHANGED_TOPIC, {
        reason: "UPDATED",
        ids: [],
        uploadId: "upload",
      });
      agentEventBus.publish(CLI_HEALTH_CHANGED_TOPIC, {
        cliHealthStatusChanged: {
          agentId: "agent",
          completion: {
            jobId: "failed-check",
            status: "FAILED",
            error: "executable missing",
            finishedAt: now.toISOString(),
          },
        },
      });
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2));
      expect(
        record.mock.calls.find(([input]) => input.kind === "DSYM_CHANGED")?.[0],
      ).toMatchObject({
        subjectKey: "upload:upload",
        payload: {
          dsym: {
            entityKind: "UPLOAD",
            uploadId: "upload",
            status: "FAILED",
            upload: { error: "invalid archive" },
          },
        },
      });
      expect(
        record.mock.calls.find(
          ([input]) => input.kind === "CLI_HEALTH_RESULT",
        )?.[0],
      ).toMatchObject({
        dedupeKey: "cli-health-result:agent:failed-check",
        payload: {
          cliHealth: {
            overall: "ISSUES",
            jobStatus: "FAILED",
            error: "executable missing",
            results: [],
          },
        },
      });
      expect(findUnique.mock.calls[0][0].select).not.toHaveProperty("ownerKey");
      expect(findUnique.mock.calls[0][0].select).not.toHaveProperty(
        "stagingPath",
      );
    } finally {
      bridge.stop();
    }
  });

  test("publishes every added domain with narrow public projections", async () => {
    const now = new Date("2026-10-28T12:00:00Z");
    getPrismaClient.mockResolvedValue({
      crashReport: {
        findUnique: vi.fn().mockResolvedValue({
          id: "crash",
          status: "SYMBOLICATED",
          updatedAt: now,
        }),
      },
      dsym: {
        findUnique: vi.fn().mockResolvedValue({
          id: "dsym",
          upload: { status: "READY", updatedAt: now },
        }),
      },
      telemetryEntry: {
        findMany: vi.fn().mockResolvedValue([
          { id: "console", entryType: "CONSOLE", level: "ERROR" },
          { id: "analytics", entryType: "ANALYTICS", eventName: "launch" },
        ]),
      },
      repositoryTransferOperation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "transfer",
          status: "PARTIAL",
          finishedAt: now,
          items: [{ status: "FAILED" }],
        }),
      },
      app: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: "app", name: "App", updatedAt: now }),
      },
    });
    const record = vi.fn().mockResolvedValue({});
    const bridge = new DomainWorkflowEventBridge({ record } as never, {
      cliHealth: {
        statusForAgent: vi.fn().mockResolvedValue({
          agentId: "agent",
          name: "Agent",
          overall: "ISSUES",
          activeJobId: null,
          lastCheckedAt: now.toISOString(),
          results: [{ state: "UNHEALTHY" }],
        }),
      } as never,
      tailscale: {
        overview: vi.fn().mockResolvedValue({
          agents: [
            {
              agent: { id: "agent", name: "Agent", privateKey: "secret" },
              supported: true,
              backendState: "Running",
            },
          ],
          templates: [],
        }),
        operation: vi.fn().mockResolvedValue({
          id: "serve",
          status: "FAILED",
          finishedAt: now,
          agents: [
            {
              agentId: "agent",
              status: "FAILED",
              error: "failed",
              job: { secret: true },
            },
          ],
        }),
      } as never,
      actionCenter: {
        list: vi.fn().mockResolvedValue({
          items: [
            {
              key: "BUILD:build",
              resourceKind: "BUILD",
              resourceId: "build",
              reason: "FAILED",
              status: "FAILED",
              label: "Build",
            },
          ],
          nextCursor: null,
        }),
      } as never,
    });
    bridge.start();
    try {
      agentEventBus.publish(CRASH_REPORTS_CHANGED_TOPIC, {
        reason: "UPDATED",
        ids: ["crash"],
      });
      agentEventBus.publish(DSYMS_CHANGED_TOPIC, {
        reason: "CREATED",
        ids: ["dsym"],
      });
      agentEventBus.publish(TELEMETRY_CHANGED_TOPIC, {
        reason: "INGESTED",
        ids: ["console", "analytics"],
      });
      agentEventBus.publish(CLI_HEALTH_CHANGED_TOPIC, {
        cliHealthStatusChanged: { agentId: "agent" },
      });
      agentEventBus.publish(TAILSCALE_SERVE_CHANGED_TOPIC, {
        operationId: "serve",
      });
      agentEventBus.publish(REPOSITORY_TRANSFER_CHANGED_TOPIC, {
        repositoryTransferChanged: "transfer",
      });
      agentEventBus.publish(APPS_CHANGED_TOPIC, { appsChanged: { id: "app" } });
      agentEventBus.publish(COMMANDS_CHANGED_TOPIC, {
        commandsChanged: {
          id: "command",
          name: "Command",
          script: "secret script",
        },
      });
      agentEventBus.publish(BUILD_SCRIPTS_CHANGED_TOPIC, {
        buildScriptsChanged: true,
      });
      agentEventBus.publish(SKILLS_CHANGED_TOPIC, { id: null });
      agentEventBus.publish(APP_NOTIFICATIONS_CHANGED_TOPIC, {
        notificationsChanged: {
          kind: "CREATED",
          notification: {
            id: "notification",
            resourceKind: "BUILD",
            resourceId: "build",
            title: "Failed",
          },
        },
      });
      agentEventBus.publish(ACTION_CENTER_CHANGED_TOPIC, {
        actionCenterChanged: true,
      });
      agentEventBus.publish(SSE_ENDPOINTS_CHANGED_TOPIC, {
        reason: "UPDATED",
        ids: ["endpoint"],
      });
      agentEventBus.publish(SSE_STORAGE_CHANGED_TOPIC, {
        reason: "SET",
        ids: ["key"],
      });
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(16));
      expect(new Set(record.mock.calls.map(([input]) => input.kind)).size).toBe(
        16,
      );
      expect(JSON.stringify(record.mock.calls)).not.toMatch(
        /secret|privateKey/,
      );
      expect(
        record.mock.calls.find(
          ([input]) => input.kind === "CLI_HEALTH_RESULT",
        )?.[0].payload.cliHealth.overall,
      ).toBe("ISSUES");
    } finally {
      bridge.stop();
    }
  });

  test("does not turn sync progress, telemetry edits, running checks, or workflow notifications into new runs", async () => {
    const record = vi.fn();
    const cliHealth = {
      statusForAgent: vi
        .fn()
        .mockResolvedValue({ activeJobId: "job", lastCheckedAt: null }),
    };
    const bridge = new DomainWorkflowEventBridge({ record } as never, {
      cliHealth: cliHealth as never,
    });
    bridge.start();
    try {
      agentEventBus.publish(SKILLS_CHANGED_TOPIC, { id: "sync-run" });
      agentEventBus.publish(TELEMETRY_CHANGED_TOPIC, {
        reason: "HIGHLIGHT_CHANGED",
        ids: ["entry"],
      });
      agentEventBus.publish(CLI_HEALTH_CHANGED_TOPIC, {
        cliHealthStatusChanged: { agentId: "agent" },
      });
      agentEventBus.publish(APP_NOTIFICATIONS_CHANGED_TOPIC, {
        notificationsChanged: {
          kind: "CREATED",
          notification: { id: "notice", resourceKind: "WORKFLOW_RUN" },
        },
      });
      await vi.waitFor(() =>
        expect(cliHealth.statusForAgent).toHaveBeenCalled(),
      );
      expect(record).not.toHaveBeenCalled();
    } finally {
      bridge.stop();
    }
    agentEventBus.publish(BUILD_SCRIPTS_CHANGED_TOPIC, {});
    await Promise.resolve();
    expect(record).not.toHaveBeenCalled();
  });
});
