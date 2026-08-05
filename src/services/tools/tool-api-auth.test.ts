import { afterEach, describe, expect, test, vi } from "vitest";

const resolveRequestPrincipal = vi.hoisted(() => vi.fn());

vi.mock("@/services/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/auth")>()),
  resolveRequestPrincipal,
}));

import {
  authorizeMcpPresetRequest,
  authorizeRunMcpRequest,
  authorizeToolRequest,
} from "./tool-api-auth";

afterEach(() => {
  vi.clearAllMocks();
});

describe("tool API authorization", () => {
  test("requires a user session for Tools page calls", async () => {
    resolveRequestPrincipal.mockResolvedValueOnce({ kind: "anonymous" });
    const denied = await authorizeToolRequest(
      new Request("https://control.example/api/tools/call"),
      "TOOLS_PAGE",
    );
    expect("response" in denied && denied.response.status).toBe(401);

    resolveRequestPrincipal.mockResolvedValueOnce({
      kind: "user",
      userId: "user-1",
      email: "user@example.com",
      sessionId: "session-1",
    });
    const allowed = await authorizeToolRequest(
      new Request("https://control.example/api/tools/call", {
        headers: { "x-request-id": "request-1" },
      }),
      "TOOLS_PAGE",
    );
    expect(allowed).toMatchObject({
      context: {
        source: "TOOLS_PAGE",
        correlationId: "request-1",
        caller: "user:user-1@unknown",
      },
    });
  });

  test("rejects anonymous unscoped MCP calls", async () => {
    resolveRequestPrincipal.mockResolvedValue({ kind: "anonymous" });
    const denied = await authorizeToolRequest(
      new Request("https://control.example/api/mcp"),
      "MCP",
    );
    expect("response" in denied && denied.response.status).toBe(401);
  });

  test("accepts user sessions and API keys for unscoped MCP", async () => {
    resolveRequestPrincipal.mockResolvedValueOnce({
      kind: "user",
      userId: "user-1",
      email: "user@example.com",
      sessionId: "session-1",
    });
    const user = await authorizeToolRequest(
      new Request("https://control.example/api/mcp"),
      "MCP",
    );
    expect(user).toMatchObject({ context: { caller: "user:user-1@unknown" } });

    resolveRequestPrincipal.mockResolvedValueOnce({
      kind: "apiKey",
      apiKeyId: "key-1",
      userId: "user-1",
      name: "Automation",
    });
    const apiKey = await authorizeToolRequest(
      new Request("https://control.example/api/mcp"),
      "MCP",
    );
    expect(apiKey).toMatchObject({
      context: { caller: "api-key:key-1@unknown" },
    });
  });

  test("uses the same user or API-key policy for preset URLs", async () => {
    resolveRequestPrincipal.mockResolvedValue({
      kind: "apiKey",
      apiKeyId: "key-1",
      userId: "user-1",
      name: null,
    });
    const allowed = await authorizeMcpPresetRequest(
      new Request("https://control.example/api/mcp?preset=preset-1"),
    );
    expect(allowed).toMatchObject({ context: { source: "MCP" } });
  });

  test("accepts only enrolled agent credentials for run-scoped URLs", async () => {
    resolveRequestPrincipal.mockResolvedValueOnce({ kind: "user" });
    const denied = await authorizeRunMcpRequest(
      new Request("https://control.example/api/mcp?run=run-1", {
        headers: { authorization: "Bearer deployment-secret" },
      }),
      {} as never,
    );
    expect("response" in denied && denied.response.status).toBe(401);

    resolveRequestPrincipal.mockResolvedValueOnce({
      kind: "agent",
      agentId: "agent-1",
    });
    const allowed = await authorizeRunMcpRequest(
      new Request("https://control.example/api/mcp?run=run-1", {
        headers: { authorization: "Bearer agent-secret" },
      }),
      {} as never,
    );
    expect(allowed).toMatchObject({
      agentId: "agent-1",
      context: { caller: "agent:agent-1@unknown", source: "MCP" },
    });
    expect(resolveRequestPrincipal).toHaveBeenLastCalledWith(
      expect.any(Headers),
      expect.anything(),
    );
  });
});
