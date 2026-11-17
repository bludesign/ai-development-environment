import type { CallToolResult } from "@modelcontextprotocol/server";

import { CommandPortConflictError } from "@/services/commands";

export function commandPortConflictDetails(error: unknown) {
  if (!(error instanceof CommandPortConflictError)) return null;
  return {
    code: "COMMAND_PORT_CONFLICT",
    message: error.message,
    portConflict: error.conflict,
  };
}

export function commandPortConflictToolResult(
  error: unknown,
): CallToolResult | null {
  const conflict = commandPortConflictDetails(error);
  if (!conflict) return null;
  const { message, ...details } = conflict;
  return {
    isError: true,
    content: [
      { type: "text", text: message },
      { type: "text", text: JSON.stringify(details) },
    ],
  };
}
