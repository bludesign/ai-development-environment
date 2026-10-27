import { selectedMcpScopes } from "@/lib/mcp-scopes";
import { describe, expect, test } from "vitest";
import { createBuiltInToolRegistry } from "./builtin-tools";
import { BUILT_IN_MCP_PERMISSIONS, requiredMcpScopes } from "./mcp-permissions";
import { mcpRequestScopeError } from "./mcp-oauth-dispatch";
import type { ToolInvocationContext } from "./tool-call-audit.service";
import type { McpToolSnapshot } from "./types";

describe("MCP server-owned permissions", () => {
  test("classifies every built-in exactly once with no stale entries", () => {
    const registry = createBuiltInToolRegistry(
      new Proxy({} as never, { get: () => () => ({}) }),
    );
    expect([...BUILT_IN_MCP_PERMISSIONS.keys()].sort()).toEqual(
      registry
        .definitions()
        .map((tool) => tool.name)
        .sort(),
    );
  });
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
