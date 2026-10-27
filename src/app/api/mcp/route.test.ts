import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callBuiltInTool: vi.fn(),
  callRunBuiltInTool: vi.fn(),
  mcpRunToolNames: vi.fn(),
  mcpPresetSnapshot: vi.fn().mockResolvedValue(null),
  builtInTools: { definitions: vi.fn(() => [] as Array<{ name: string }>) },
}));
const authorization = vi.hoisted(() => ({
  authorizeMcpPresetRequest: vi.fn(),
  authorizeRunMcpRequest: vi.fn(),
  authorizeToolRequest: vi.fn(),
}));

vi.mock("@/services/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tools")>()),
  ...authorization,
}));

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({
    agentControlService: {},
    toolsService: mocks,
  }),
}));

import { DELETE, GET, POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.builtInTools.definitions.mockReturnValue([]);
  const allowed = {
    context: {
      caller: "api-key:key-1@unknown",
      correlationId: "request-1",
      source: "MCP",
    },
  };
  authorization.authorizeMcpPresetRequest.mockResolvedValue(allowed);
  authorization.authorizeToolRequest.mockResolvedValue(allowed);
});

describe("MCP endpoint authentication", () => {
  test("rejects mixed and duplicate scope query modes", async () => {
    await expect(
      POST(
        new Request(
          "https://control.example/api/mcp?preset=preset-1&run=run-1",
          { method: "POST" },
        ),
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      POST(
        new Request("https://control.example/api/mcp?preset=one&preset=two", {
          method: "POST",
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
  });

  test("allows an authorized API key for preset URLs", async () => {
    const response = await POST(
      new Request("https://control.example/api/mcp?preset=preset-1", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "MCP_PRESET_NOT_FOUND" },
    });
    expect(mocks.mcpPresetSnapshot).toHaveBeenCalledWith("preset-1");
  });

  test.each([GET, POST, DELETE])(
    "allows authorized unscoped requests",
    async (handler) => {
      const response = await handler(
        new Request("https://control.example/api/mcp", { method: "POST" }),
      );
      expect([401, 503]).not.toContain(response.status);
    },
  );

  test("rejects invalid credentials", async () => {
    authorization.authorizeToolRequest.mockResolvedValueOnce({
      response: Response.json(
        { error: { message: "Unauthorized" } },
        { status: 401 },
      ),
    });
    const response = await POST(
      new Request("https://control.example/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer incorrect" },
      }),
    );
    expect(response.status).toBe(401);
  });

  test("returns an HTTP scope challenge for the whole batch before any tool side effects", async () => {
    mocks.builtInTools.definitions.mockReturnValue([
      { name: "get_codebases" },
      { name: "create_agent_run" },
    ]);
    authorization.authorizeToolRequest.mockResolvedValueOnce({
      context: {
        caller: "oauth:user:u:client:c",
        correlationId: "scope-test",
        source: "MCP",
        oauthPrincipal: {
          kind: "mcpOAuth",
          userId: "u",
          clientId: "c",
          authorizationId: "a",
          scopes: ["mcp:read"],
        },
      },
    });
    const response = await POST(
      new Request("https://control.example/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "get_codebases", arguments: {} },
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "create_agent_run", arguments: {} },
          },
        ]),
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
    );
    expect(response.headers.get("www-authenticate")).toContain(
      "mcp:destructive",
    );
    expect(response.headers.get("x-request-id")).toBe("scope-test");
    expect(mocks.callBuiltInTool).not.toHaveBeenCalled();
    expect(mocks.callRunBuiltInTool).not.toHaveBeenCalled();
  });

  test("a preset's externally supplied read-only annotation never grants OAuth permission", async () => {
    authorization.authorizeMcpPresetRequest.mockResolvedValueOnce({
      context: {
        caller: "oauth:user:u:client:c",
        correlationId: "scope-test",
        source: "MCP",
        oauthPrincipal: {
          kind: "mcpOAuth",
          userId: "u",
          clientId: "c",
          authorizationId: "a",
          scopes: ["mcp:read", "mcp:write"],
        },
      },
    });
    mocks.mcpPresetSnapshot.mockResolvedValueOnce({
      schemaVersion: 1,
      tools: [
        {
          name: "external_read",
          reference: { source: "EXTERNAL", name: "read", serverId: "s" },
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    const response = await POST(
      new Request("https://control.example/api/mcp?preset=one", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "external_read", arguments: {} },
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      "mcp:destructive",
    );
    expect(mocks.callBuiltInTool).not.toHaveBeenCalled();
  });
});
