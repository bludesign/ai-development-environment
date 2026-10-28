import { createInsufficientScopeError } from "better-auth/oauth2";
import {
  activeMcpAuthorization,
  mcpOAuthChallenge,
} from "@/services/auth/mcp-oauth";
import { requiredMcpScopes } from "./mcp-permissions";
import type { ToolInvocationContext } from "./tool-call-audit.service";
import type { McpToolSnapshot } from "./types";

export async function assertMcpToolPermission(
  context: ToolInvocationContext | undefined,
  name: string,
  external = false,
): Promise<void> {
  const principal = context?.oauthPrincipal;
  if (!principal) return;
  if (!(await activeMcpAuthorization(principal)))
    throw new Error("MCP authorization has been revoked");
  const required = requiredMcpScopes(name, external);
  if (required.some((scope) => !principal.scopes.includes(scope)))
    throw createInsufficientScopeError(required);
}

/** Check the entire HTTP batch before dispatching any member. Keep descriptors
 * visible so clients can discover required permissions and ask for consent.
 */
export function mcpRequestScopeError(
  body: unknown,
  context: ToolInvocationContext,
  snapshot?: McpToolSnapshot,
  availableToolNames?: ReadonlySet<string>,
): Response | null {
  const principal = context.oauthPrincipal;
  if (!principal) return null;
  const needed = new Set<string>();
  for (const request of Array.isArray(body) ? body : [body]) {
    if (
      !request ||
      typeof request !== "object" ||
      request.method !== "tools/call" ||
      typeof request.params?.name !== "string"
    )
      continue;
    const entry = snapshot?.tools.find(
      (tool) => tool.name === request.params.name,
    );
    // Consent cannot make an unselected or nonexistent tool available. Let the
    // protocol handler return its ordinary tool-selection error in that case.
    if (snapshot && !entry) continue;
    if (availableToolNames && !availableToolNames.has(request.params.name))
      continue;
    for (const scope of requiredMcpScopes(
      entry?.reference.name ?? request.params.name,
      entry?.reference.source === "EXTERNAL",
    ))
      needed.add(scope);
  }
  return [...needed].some((scope) => !principal.scopes.includes(scope))
    ? mcpOAuthChallenge(403, [...needed])
    : null;
}
