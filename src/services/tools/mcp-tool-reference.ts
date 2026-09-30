import { createHash } from "node:crypto";
import type { McpToolReference } from "./types";

export function toolReferenceKey(tool: McpToolReference): string {
  return JSON.stringify(
    tool.source === "BUILTIN"
      ? ["BUILTIN", tool.name]
      : ["EXTERNAL", tool.serverId, tool.name],
  );
}

export function externalMcpName(serverId: string, name: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([serverId, name]))
    .digest("hex")
    .slice(0, 16);
  const label = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 38) || "tool";
  return `aide_ext_${hash}_${label}`;
}

export function externalEndpointHash(server: {
  url: string;
  transport: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([new URL(server.url).toString(), server.transport]))
    .digest("hex");
}
