export const MCP_SCOPES = ["mcp:read", "mcp:write", "mcp:destructive"] as const;
export const MCP_PERMISSION_SCOPES = {
  read: ["mcp:read"],
  write: ["mcp:read", "mcp:write"],
  destructive: [...MCP_SCOPES],
} as const;

/** A consent selection cannot grant scopes the client did not request. */
export function selectedMcpScopes(
  requested: readonly string[],
  write: boolean,
  destructive: boolean,
  offline: boolean,
): string[] {
  const selected = new Set([
    "mcp:read",
    ...(write ? ["mcp:write"] : []),
    ...(write && destructive ? ["mcp:destructive"] : []),
    ...(offline ? ["offline_access"] : []),
  ]);
  return requested.filter((scope) => selected.has(scope));
}
