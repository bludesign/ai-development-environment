import { describe, expect, test, vi } from "vitest";

import type { AgentControlService } from "@/services/agent-control";
import type { BuildsService } from "@/services/builds";
import type {
  CodebasesService,
  CodebaseToolsService,
} from "@/services/codebases";
import type { PushNotificationsService } from "@/services/push-notifications";
import type { TelemetryService } from "@/services/telemetry";

import { createBuiltInToolRegistry } from "./builtin-tools";

function registry() {
  const telemetry = {
    timeline: vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      matchingCount: 0,
      totalCount: 0,
    }),
    entry: vi.fn(),
    timelineSinceLatestSeparator: vi.fn(),
    fields: vi.fn().mockResolvedValue([]),
    facets: vi.fn().mockResolvedValue({}),
    clearScoped: vi.fn(),
    separators: vi.fn(),
    addSeparator: vi.fn(),
    settings: vi.fn().mockResolvedValue({
      localBaseUrlOverride: null,
      remoteBaseUrlOverride: null,
      consoleCollectionEnabled: true,
      analyticsCollectionEnabled: true,
      detectedLocalBaseUrl: "http://localhost:3000",
      detectedRemoteBaseUrl: "https://example.com",
      effectiveLocalBaseUrl: "http://localhost:3000",
      effectiveRemoteBaseUrl: "https://example.com",
      updatedAt: "2026-07-21T12:00:00.000Z",
    }),
  } as unknown as TelemetryService;
  const push = {
    registrations: vi.fn().mockResolvedValue([]),
    settings: vi.fn(),
    channels: vi.fn(),
    presets: vi.fn(),
    history: vi.fn().mockResolvedValue([]),
    historyItem: vi.fn(),
    preset: vi.fn(),
    send: vi.fn(),
    resend: vi.fn(),
  } as unknown as PushNotificationsService;
  const agents = {
    listAgents: vi.fn().mockResolvedValue([]),
    requestCodebaseReconcile: vi.fn().mockResolvedValue(1),
  } as unknown as AgentControlService;
  const codebaseTools = {
    list: vi.fn().mockResolvedValue([]),
    getById: vi.fn(),
    getByPath: vi.fn(),
  } as unknown as CodebaseToolsService;
  const codebases = {} as CodebasesService;
  const builds = {} as BuildsService;
  return {
    telemetry,
    push,
    agents,
    value: createBuiltInToolRegistry({
      codebaseTools,
      codebases,
      builds,
      telemetry,
      pushNotifications: push,
      agents,
    }),
  };
}

describe("built-in tool registry", () => {
  test("projects the complete nested catalog with globally unique names", () => {
    const catalog = registry().value.catalog();
    expect(catalog.map(({ id }) => id)).toEqual([
      "builtin:codebases",
      "builtin:builds",
      "builtin:debugging",
      "builtin:agents",
    ]);
    const debugging = catalog[2]!;
    expect(debugging.children.map(({ id }) => id)).toEqual([
      "builtin:debugging:console-logs",
      "builtin:debugging:analytics-events",
      "builtin:debugging:push-notifications",
    ]);
    expect(debugging.tools.map(({ name }) => name)).toEqual([
      "get_unified_events",
      "get_unified_event",
      "search_unified_events",
      "get_unified_events_since_latest_separator",
      "get_unified_event_search_metadata",
      "clear_unified_events",
      "get_telemetry_separators",
      "add_telemetry_separator",
      "get_telemetry_settings",
    ]);
    expect(debugging.children[0]!.tools.map(({ name }) => name)).toEqual([
      "get_console_logs",
      "get_console_log",
      "search_console_logs",
      "get_console_logs_since_latest_separator",
      "get_console_log_search_metadata",
      "clear_console_logs",
    ]);
    expect(debugging.children[1]!.tools.map(({ name }) => name)).toEqual([
      "get_analytics_events",
      "get_analytics_event",
      "search_analytics_events",
      "get_analytics_events_since_latest_separator",
      "get_analytics_event_search_metadata",
      "clear_analytics_events",
    ]);
    expect(debugging.children[2]!.tools.map(({ name }) => name)).toEqual([
      "get_push_notification_registrations",
      "get_push_notification_settings",
      "get_push_notification_channels",
      "get_push_notification_presets",
      "get_push_notification_history",
      "get_push_notification_history_item",
      "preview_push_notification",
      "send_push_notification",
      "send_push_notification_preset",
      "resend_push_notification",
    ]);
    const names = registry()
      .value.definitions()
      .map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("advertises satisfiable JSON schemas for push send tools", () => {
    type ObjectSchema = {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    const pushTools = registry().value.catalog()[2]!.children[2]!.tools;
    const cases = [
      ["send_push_notification", ["requestId", "editor"]],
      ["send_push_notification_preset", ["requestId", "presetId"]],
    ] as const;

    for (const [name, commonFields] of cases) {
      const schema = pushTools.find((tool) => tool.name === name)!
        .inputSchema as {
        allOf?: unknown;
        oneOf?: ObjectSchema[];
      };
      expect(schema.allOf).toBeUndefined();
      expect(schema.oneOf).toHaveLength(4);
      for (const variant of schema.oneOf ?? []) {
        expect(Object.keys(variant.properties ?? {})).toEqual(
          expect.arrayContaining(["targetMode", ...commonFields]),
        );
        expect(variant.required).toEqual(
          expect.arrayContaining(["targetMode", ...commonFields]),
        );
        expect(variant.additionalProperties).toBe(false);
      }
    }
  });

  test("parses and invokes tools from parent and child groups", async () => {
    const { value, telemetry, agents, push } = registry();
    await expect(
      value.call("builtin:debugging", "get_telemetry_settings", {}),
    ).resolves.toMatchObject({
      structuredContent: {
        settings: { consoleCollectionEnabled: true },
      },
    });
    await expect(
      value.call("builtin:debugging:console-logs", "get_console_logs", {}),
    ).resolves.toMatchObject({ structuredContent: { items: [] } });
    expect(telemetry.timeline).toHaveBeenCalledWith(
      expect.objectContaining({ view: "CONSOLE", first: 200 }),
    );
    await expect(
      value.call(
        "builtin:debugging:push-notifications",
        "get_push_notification_history",
        {},
      ),
    ).resolves.toMatchObject({ structuredContent: { batches: [] } });
    expect(push.history).toHaveBeenCalledWith(100);
    await expect(
      value.call("builtin:agents", "request_agent_codebase_reconcile", {
        agentId: "agent-1",
      }),
    ).resolves.toMatchObject({ structuredContent: { requested: true } });
    expect(agents.requestCodebaseReconcile).toHaveBeenCalledWith(["agent-1"]);
  });

  test("rejects a valid name routed through the wrong catalog group", async () => {
    const { value } = registry();
    await expect(
      value.call("builtin:debugging", "get_console_logs", {}),
    ).rejects.toThrow("Unknown built-in tool");
  });

  test("never exposes stored push tokens through registration tools", async () => {
    const { value, push } = registry();
    const token = "AB".repeat(32);
    vi.mocked(push.registrations).mockResolvedValue([
      {
        id: "registration-1",
        clientRegistrationId: "client-1",
        token,
        tokenMasked: "ABABABAB…ABABABAB",
        tokenHash: "hash",
        topic: "com.example.app",
        environment: "SANDBOX",
        pushTypesJson: '["alert"]',
        supportedPushTypes: ["alert"],
        displayName: "iPhone",
        deviceModel: null,
        osVersion: null,
        appVersion: null,
        appBuild: null,
        locale: null,
        pushMagic: null,
        status: "ACTIVE",
        invalidatedAt: null,
        lastFailureReason: null,
        lastFailureAt: null,
        lastRegisteredAt: new Date("2026-07-21T12:00:00Z"),
        lastSentAt: null,
        createdAt: new Date("2026-07-21T12:00:00Z"),
        updatedAt: new Date("2026-07-21T12:00:00Z"),
      } as never,
    ]);

    const result = await value.call(
      "builtin:debugging:push-notifications",
      "get_push_notification_registrations",
      {},
    );

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result).toMatchObject({
      structuredContent: {
        registrations: [
          { tokenMasked: "ABABABAB…ABABABAB", pushMagicConfigured: false },
        ],
      },
    });
  });

  test("loads and sends a saved push preset with an idempotent request ID", async () => {
    const { value, push } = registry();
    const now = new Date("2026-07-21T12:00:00Z");
    const editor = {
      pushType: "alert",
      headers: { topic: "com.example.app", priority: 10 },
      aps: { alert: { title: "Hello" } },
      custom: {},
      liveActivity: null,
      credentialId: null,
    };
    vi.mocked(push.preset).mockResolvedValue({
      id: "preset-1",
      name: "Hello",
      editorJson: JSON.stringify(editor),
      createdAt: now,
      updatedAt: now,
    });
    vi.mocked(push.send).mockResolvedValue({
      id: "batch-1",
      requestId: "request-1",
      status: "QUEUED",
      editorJson: JSON.stringify(editor),
      payloadJson: '{"aps":{}}',
      headersJson: "{}",
      targetMode: "ALL",
      channelId: null,
      recipientCount: 1,
      successCount: 0,
      failureCount: 0,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      deliveries: [],
    } as never);

    await expect(
      value.call(
        "builtin:debugging:push-notifications",
        "send_push_notification_preset",
        {
          requestId: "request-1",
          presetId: "preset-1",
          targetMode: "ALL",
        },
      ),
    ).resolves.toMatchObject({
      structuredContent: { batch: { id: "batch-1", status: "QUEUED" } },
    });
    expect(push.send).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        targetMode: "ALL",
        editor,
      }),
    );
  });
});
