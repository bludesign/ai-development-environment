import { MCP_PERMISSION_SCOPES, selectedMcpScopes } from "@/lib/mcp-scopes";
import { describe, expect, test } from "vitest";
import { createBuiltInToolRegistry } from "./builtin-tools";
import {
  BUILT_IN_MCP_PERMISSIONS,
  mcpScopeMetadata,
  requiredMcpScopes,
  type McpPermission,
} from "./mcp-permissions";
import { mcpRequestScopeError } from "./mcp-oauth-dispatch";
import type { ToolInvocationContext } from "./tool-call-audit.service";
import type { McpToolSnapshot } from "./types";

function productionRegistry() {
  const placeholder = {} as never;
  return createBuiltInToolRegistry({
    codebaseTools: placeholder,
    codebases: placeholder,
    builds: placeholder,
    telemetry: placeholder,
    pushNotifications: placeholder,
    agents: placeholder,
    diskSpace: placeholder,
    worktrees: placeholder,
    runs: placeholder,
    commands: placeholder,
    jira: placeholder,
    jiraWebhooks: placeholder,
    github: placeholder,
    gitlab: placeholder,
    skills: placeholder,
    buildData: placeholder,
    tailscale: placeholder,
    signingAssets: placeholder,
    iosDevices: placeholder,
    notifications: placeholder,
    ccusage: placeholder,
    modelCosts: placeholder,
    systemStatus: placeholder,
    polling: placeholder,
    credentials: placeholder,
    cacheServer: placeholder,
    toolAudit: placeholder,
    testExternalMcpServer: async () => null,
    listMcpToolPresets: async () => [],
    workflows: () => placeholder,
    worktreeAutomations: () => placeholder,
    sse: placeholder,
    globalSearch: placeholder,
    actionCenter: placeholder,
    apps: placeholder,
    cliHealth: placeholder,
    crashes: placeholder,
    repositoryTransfer: placeholder,
    toolAdministration: placeholder,
  });
}

function oauthContext(scopes: readonly string[]): ToolInvocationContext {
  return {
    caller: "test",
    correlationId: "test",
    source: "MCP",
    oauthPrincipal: {
      kind: "mcpOAuth",
      userId: "u",
      clientId: "c",
      authorizationId: "a",
      scopes: [...scopes],
    },
  };
}

const newPermissionBoundaries: Array<[string, McpPermission]> = [
  ["get_repository_transfer_operation", "read"],
  ["get_crash_settings", "read"],
  ["get_run_drafts", "read"],
  ["export_command", "read"],
  ["get_build_signing_options", "read"],
  ["get_external_mcp_servers", "read"],
  ["preview_mcp_tool_preset_import", "read"],
  ["sse_history_get_view_settings", "read"],
  ["create_app", "write"],
  ["save_action_center_settings", "write"],
  ["update_dsym_upload", "write"],
  ["rename_agent", "write"],
  ["save_model_cost_settings", "write"],
  ["preview_repository_transfer", "write"],
  ["cancel_run_question", "destructive"],
  ["run_cli_health_checks", "destructive"],
  ["save_cli_health_settings", "destructive"],
  ["save_external_pipeline_actions", "destructive"],
  ["import_command", "destructive"],
  ["create_external_mcp_server", "destructive"],
  ["update_external_mcp_server", "destructive"],
  ["save_cache_server_settings", "destructive"],
  ["gitlab_update_connection_settings", "destructive"],
  ["create_mcp_tool_preset", "destructive"],
  ["update_mcp_tool_preset", "destructive"],
  ["import_mcp_tool_presets", "destructive"],
  ["apply_repository_transfer", "destructive"],
  ["sync_app_repositories", "destructive"],
  ["retry_repository_transfer", "destructive"],
  ["reparse_build_configuration", "destructive"],
  ["set_codebase_build_scripts", "destructive"],
  ["preview_worktree_ticket_branch", "destructive"],
  ["save_run_draft", "destructive"],
  ["set_auto_retry_rule_enabled", "destructive"],
  ["set_workflow_quick_action", "destructive"],
  ["gitlab_run_pipeline_action", "destructive"],
  ["gitlab_submit_merge", "destructive"],
];

describe("MCP server-owned permissions", () => {
  test("classifies every built-in exactly once with no stale entries", () => {
    const registry = productionRegistry();
    expect(registry.definitions()).toHaveLength(560);
    expect([...BUILT_IN_MCP_PERMISSIONS.keys()].sort()).toEqual(
      registry
        .definitions()
        .map((tool) => tool.name)
        .sort(),
    );
  });
  test.each(newPermissionBoundaries)(
    "%s publishes and enforces the %s tier before dispatch",
    (name, permission) => {
      const scopes = [...MCP_PERMISSION_SCOPES[permission]];
      expect(requiredMcpScopes(name)).toEqual(scopes);
      expect(mcpScopeMetadata(name)).toEqual({
        "aide/requiredScopes": scopes,
        securitySchemes: [{ type: "oauth2", scopes }],
      });
      for (const granted of Object.values(MCP_PERMISSION_SCOPES)) {
        const denied = mcpRequestScopeError(
          { method: "tools/call", params: { name } },
          oauthContext(granted),
          undefined,
          new Set([name]),
        );
        if (scopes.every((scope) => granted.includes(scope as never))) {
          expect(denied).toBeNull();
        } else {
          expect(denied?.status).toBe(403);
          expect(denied?.headers.get("www-authenticate")).toContain(
            'error="insufficient_scope"',
          );
        }
      }
    },
  );
  test.each([
    "start_custom_command",
    "create_command",
    "update_command",
    "create_agent_run",
    "steer_agent_run",
    "trigger_workflow",
    "create_workflow",
    "update_workflow_step",
    "publish_workflow",
    "configure_worktree_auto_sync",
    "run_worktree_preparations",
    "save_build_script",
    "run_codebase_git_operation",
    "sse_script_test",
  ])(
    "requires destructive permission for indirect execution through %s",
    (name) => {
      expect(requiredMcpScopes(name)).toEqual([
        "mcp:read",
        "mcp:write",
        "mcp:destructive",
      ]);
    },
  );
  test("uses cumulative tiers and fails closed for unknown/external tools", () => {
    expect(requiredMcpScopes("get_codebases")).toEqual(["mcp:read"]);
    expect(requiredMcpScopes("add_jira_comment")).toEqual([
      "mcp:read",
      "mcp:write",
    ]);
    expect(requiredMcpScopes("delete_worktree")).toHaveLength(3);
    expect(requiredMcpScopes("get_codebases", true)).toHaveLength(3);
    expect(requiredMcpScopes("future_tool")).toHaveLength(3);
  });
  test("new consent defaults to requested read only and never grants unrequested scopes", () => {
    const requested = [
      "mcp:read",
      "mcp:write",
      "mcp:destructive",
      "offline_access",
    ];
    expect(selectedMcpScopes(requested, false, false, false)).toEqual([
      "mcp:read",
    ]);
    expect(selectedMcpScopes(requested, false, true, false)).toEqual([
      "mcp:read",
    ]);
    expect(selectedMcpScopes(["mcp:read"], true, true, true)).toEqual([
      "mcp:read",
    ]);
    expect(selectedMcpScopes(requested, true, false, true)).toEqual([
      "mcp:read",
      "mcp:write",
      "offline_access",
    ]);
  });
  test("preflights an entire batch and intersects preset selection with permissions", async () => {
    const context: ToolInvocationContext = {
      caller: "test",
      correlationId: "test",
      source: "MCP",
      oauthPrincipal: {
        kind: "mcpOAuth",
        userId: "u",
        clientId: "c",
        authorizationId: "a",
        scopes: ["mcp:read"],
      },
    };
    expect(mcpRequestScopeError({ method: "tools/list" }, context)).toBeNull();
    expect(
      mcpRequestScopeError(
        { method: "tools/call", params: { name: "get_codebases" } },
        context,
      ),
    ).toBeNull();
    const denied = mcpRequestScopeError(
      [
        { method: "tools/call", params: { name: "get_codebases" } },
        { method: "tools/call", params: { name: "create_agent_run" } },
      ],
      context,
    );
    expect(denied?.status).toBe(403);
    expect(denied?.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
    );
    const snapshot = {
      schemaVersion: 1,
      tools: [
        {
          name: "get_codebases",
          reference: {
            source: "EXTERNAL",
            name: "get_codebases",
            serverId: "s",
          },
        },
      ],
    } as McpToolSnapshot;
    expect(
      mcpRequestScopeError(
        { method: "tools/call", params: { name: "get_codebases" } },
        context,
        snapshot,
      )?.status,
    ).toBe(403);
  });
  test("does not challenge for scopes when consent cannot make the tool available", () => {
    const context: ToolInvocationContext = {
      caller: "test",
      correlationId: "test",
      source: "MCP",
      oauthPrincipal: {
        kind: "mcpOAuth",
        userId: "u",
        clientId: "c",
        authorizationId: "a",
        scopes: ["mcp:read"],
      },
    };
    const call = { method: "tools/call", params: { name: "create_agent_run" } };
    expect(
      mcpRequestScopeError(call, context, { schemaVersion: 1, tools: [] }),
    ).toBeNull();
    expect(
      mcpRequestScopeError(
        call,
        context,
        undefined,
        new Set(["get_codebases"]),
      ),
    ).toBeNull();
  });
});
